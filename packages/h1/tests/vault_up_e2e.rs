//! H1 (hardening backlog): end-to-end `graphloop up` against a fake `h1` for EVERY vault
//! provider in `PROVIDERS`. Per provider, wired through its fake CLI / fixture:
//! (1) the fake h1 was invoked to open the lab;
//! (2) the fake secret IS present in the recorded environment of the lab invocation;
//! (3) the fake secret appears in NO recorded argv, NO manifest file, NO file under the
//! run dir, and not in the `up` output. A provider with no wiring here fails the test
//! (the match in `setup` panics), never skips silently.

#![cfg(unix)]

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use h1::yah::cli::{ProcessRunner, UpRequest, up_core};
use h1::yah::manifest::{Edge, Node, PickInfo};
use h1::yah::plan::{OpenStep, Plan};
use h1::yah::spec::{Part, Templ, Vault};
use h1::yah::vault::{PROVIDERS, Vaults};

type EnvFn = Box<dyn Fn(&str) -> Option<String>>;

fn no_env() -> EnvFn { Box::new(|_| None) }

/// A fake provider CLI: ignores its argv, prints the prepared stdout file, exit 0.
fn fake_cli(dir: &Path, name: &str, stdout: &str) -> PathBuf {
    let out_file = dir.join(format!("{name}.stdout"));
    std::fs::write(&out_file, stdout).unwrap();
    let bin = dir.join(name);
    std::fs::write(&bin, format!("#!/bin/sh\ncat \"{}\"\nexit 0\n", out_file.display())).unwrap();
    std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
    bin
}

/// Per-provider vault + env lookup. The vault key is always `TOKEN`.
fn setup(provider: &str, dir: &Path, secret: &str) -> (Vault, EnvFn) {
    let mut v = Vault { name: "v".into(), provider: provider.into(), path: None, account: None, command: Vec::new(), secrets: Vec::new(), line: 1 };
    match provider {
        "dotenv" => {
            std::fs::write(dir.join("fleet.env"), format!("TOKEN={secret}\n")).unwrap();
            v.path = Some("fleet.env".into());
            (v, no_env())
        }
        "env" => {
            let s = secret.to_owned();
            (v, Box::new(move |name: &str| if name == "TOKEN" { Some(s.clone()) } else { None }))
        }
        "command" => {
            let bin = fake_cli(dir, "cmdcli", secret);
            v.command = vec![bin.to_string_lossy().into_owned(), "{ref}".into()];
            (v, no_env())
        }
        "1password" => {
            let bin = fake_cli(dir, "op", secret);
            v.command = vec![bin.to_string_lossy().into_owned()];
            v.secrets = vec![("TOKEN".into(), "op://vault/item/field".into())];
            (v, no_env())
        }
        "bitwarden" => {
            let bin = fake_cli(dir, "bw", secret);
            v.command = vec![bin.to_string_lossy().into_owned()];
            v.secrets = vec![("TOKEN".into(), "myitem".into())];
            (v, no_env())
        }
        "bitwarden-secrets" => {
            let bin = fake_cli(dir, "bws", &format!("{{\"value\":\"{secret}\"}}"));
            v.command = vec![bin.to_string_lossy().into_owned()];
            v.secrets = vec![("TOKEN".into(), "secret-id-123".into())];
            (v, no_env())
        }
        "keychain" => {
            let bin = fake_cli(dir, "security", secret);
            v.command = vec![bin.to_string_lossy().into_owned()];
            v.secrets = vec![("TOKEN".into(), "myservice".into())];
            (v, no_env())
        }
        other => panic!("no fake-h1 e2e wiring for vault provider {other:?}; add a case in setup()"),
    }
}

/// Fake `h1`: records every invocation's argv (one line per call) and, on `open`, its
/// full process environment. The two records live in separate files outside the run
/// and manifest dirs: the secret may appear ONLY in the env record.
fn fake_h1(dir: &Path) -> (PathBuf, PathBuf, PathBuf) {
    let argv_log = dir.join("argv.log");
    let env_log = dir.join("env.log");
    let bin = dir.join("h1");
    let script = format!("#!/bin/sh\necho \"$@\" >> \"{argv}\"\ncase \"$1\" in\nlist) echo '[]' ;;\nconsole) echo SNAPSHOT ;;\nopen) printenv >> \"{env}\" ;;\nesac\nexit 0\n", argv = argv_log.display(), env = env_log.display());
    std::fs::write(&bin, script).unwrap();
    std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
    (bin, argv_log, env_log)
}

fn plan() -> Plan {
    let argv = vec![
        Templ::lit("open"),
        Templ::lit("-n"),
        Templ::lit("alpha"),
        Templ::lit("--env"),
        Templ(vec![Part::Lit("FLEET_TOKEN=".into()), Part::Vault("v".into(), "TOKEN".into())]),
        Templ::lit("--env"),
        Templ::lit("PLAIN=visible"),
        Templ::lit("--"),
        Templ::lit("cat"),
    ];
    let step = OpenStep { harness: "alpha".into(), name: "alpha".into(), role: "worker".into(), parent: None, model: "anthropic/claude-haiku-5-5".into(), argv };
    Plan { team: "t".into(), root: "alpha".into(), steps: vec![step], edges: Vec::<Edge>::new() }
}

fn nodes() -> Vec<Node> {
    vec![Node { name: "alpha".into(), harness: "alpha".into(), role: "worker".into(), parent: None, requested_model: "haiku".into(), model: "anthropic/claude-haiku-5-5".into(), model_label: "haiku".into(), pick: PickInfo { via: "pinned".into(), rule: None, reason: "pinned".into(), degraded_level: 0 }, tools: vec![], vault_env: Vec::new() }]
}

fn all_files_text(dir: &Path) -> String {
    let mut out = String::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&d) else { continue };
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() { stack.push(p); } else if let Ok(bytes) = std::fs::read(&p) { out.push_str(&String::from_utf8_lossy(&bytes)); out.push('\n'); }
        }
    }
    out
}

fn run_one(provider: &str) {
    let dir = tempfile::tempdir().unwrap();
    let secret = format!("fake-secret-{provider}-9f2a");
    let (vault, env_fn) = setup(provider, dir.path(), &secret);
    let vaults = [vault];
    let vaults_ref = Vaults::new(&vaults, dir.path().to_path_buf(), &*env_fn);
    let vault_fn = |name: &str, key: &str| vaults_ref.get(name, key);
    let (bin, argv_log, env_log) = fake_h1(dir.path());
    let plan = plan();
    let home = dir.path().join("home");
    let manifests = dir.path().join("manifests");
    let req = UpRequest { plan: &plan, nodes: nodes(), source: "/tmp/t.yah".into(), home: home.clone(), manifest_dir: manifests.clone(), run: "t-1-aaaa".into(), now_ms: 1, env: &*env_fn, vault: &vault_fn };
    let out = up_core(&req, &ProcessRunner { bin }).unwrap_or_else(|e| panic!("{provider}: graphloop up failed: {e}"));
    let argv = std::fs::read_to_string(&argv_log).unwrap_or_default();
    assert!(argv.contains("open") && argv.contains("-n alpha"), "{provider}: fake h1 was not invoked to open the lab:\n{argv}");
    assert!(argv.contains("PLAIN=visible"), "{provider}: plain env entries still use --env:\n{argv}");
    assert!(!argv.contains("FLEET_TOKEN"), "{provider}: the secret entry must not be on any command line at all:\n{argv}");
    assert!(!argv.contains(&secret), "{provider}: secret leaked into recorded argv:\n{argv}");
    let env_rec = std::fs::read_to_string(&env_log).unwrap_or_default();
    assert!(env_rec.contains(&format!("FLEET_TOKEN={secret}")), "{provider}: secret missing from the lab invocation environment record:\n{env_rec}");
    assert!(!out.output.contains(&secret), "{provider}: secret leaked into up output");
    for d in [&home, &manifests] {
        assert!(!all_files_text(d).contains(&secret), "{provider}: a file written by the run (under {}) contains the secret", d.display());
    }
}

#[test]
fn up_opens_lab_with_secret_in_env_only_for_every_provider() {
    for provider in PROVIDERS {
        run_one(provider.name);
    }
}

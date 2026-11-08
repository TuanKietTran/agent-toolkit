//! Integration tests for `vault` blocks and `${vault.NAME.KEY}` (secret handling).
//!
//! Three properties matter most and are tested end to end against a fake `h1` script:
//! a secret reaches the lab through its ENVIRONMENT only, never through a command line; a secret
//! that cannot be fetched stops the run before any lab is opened; and no file written by a run
//! (manifest, run directory) contains a secret value.

use std::collections::BTreeMap;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use graphloop::cli::*;
use graphloop::load::load_str;
use graphloop::manifest::{Edge, Node, PickInfo};
use graphloop::plan::{OpenStep, Plan};
use graphloop::spec::{Part, Templ};
use graphloop::vault::Vaults;

const SECRET: &str = "s3cr3t-token-9f2a";

const GOOD: &str = r#"yah 1

vault "local" {
  provider = "dotenv"
  path     = "fleet.env"
  secrets  = {
    FLEET_TOKEN = "FLEET_TOKEN"
    GH_TOKEN    = "GITHUB_TOKEN"
  }
}

vault "any" {
  provider = "env"
}

provider "anthropic" {
  type = "anthropic"
}

model "haiku" {
  provider = "anthropic"
  id       = "claude-haiku-5-5"
}

system_one {
  fallback = "haiku"
}

harness "alpha" {
  kind  = "h1"
  role  = "worker"
  model = "haiku"
  open {
    command = ["cat"]
    env = {
      FLEET_TOKEN = "${vault.local.FLEET_TOKEN}"
      OTHER       = "${vault.any.WHATEVER}"
    }
  }
}

team "t" {
  root    = "alpha"
  members = []
}
"#;

fn load(src: &str) -> Result<graphloop::spec::Spec, String> {
    load_str("t.yah", src, &BTreeMap::new()).map_err(|d| d.0.iter().map(|x| format!("{}: {} {}", x.line, x.summary, x.detail)).collect::<Vec<_>>().join("\n"))
}

#[test]
fn canonical_vault_file_loads_into_the_spec() {
    let spec = load(GOOD).unwrap();
    assert_eq!(spec.vaults.len(), 2);
    let local = spec.vault("local").unwrap();
    assert_eq!(local.provider, "dotenv");
    assert_eq!(local.path.as_deref(), Some("fleet.env"));
    assert_eq!(local.secrets, vec![("FLEET_TOKEN".to_owned(), "FLEET_TOKEN".to_owned()), ("GH_TOKEN".to_owned(), "GITHUB_TOKEN".to_owned())]);
    let env = &spec.harness("alpha").unwrap().open.env;
    assert_eq!(env[0].1, Templ(vec![Part::Vault("local".into(), "FLEET_TOKEN".into())]));
    assert_eq!(env[0].1.display(), "${vault.local.FLEET_TOKEN}");
}

#[test]
fn provider_can_be_switched_with_a_variable() {
    let src = GOOD.replace("provider = \"dotenv\"", "provider = var.backend").replace("vault \"local\" {", "variable \"backend\" {\n  default = \"dotenv\"\n}\n\nvault \"local\" {");
    let spec = load(&src).unwrap();
    assert_eq!(spec.vault("local").unwrap().provider, "dotenv");
    let mut over = BTreeMap::new();
    over.insert("backend".to_owned(), "env".to_owned());
    let spec = load_str("t.yah", &src.replace("  path     = \"fleet.env\"\n", ""), &over).unwrap();
    assert_eq!(spec.vault("local").unwrap().provider, "env");
}

fn errors(src: &str) -> String {
    load(src).expect_err("expected a diagnostic")
}

#[test]
fn vault_reference_is_rejected_in_a_command_line() {
    let e = errors(&GOOD.replace("command = [\"cat\"]", "command = [\"cat\", \"${vault.local.FLEET_TOKEN}\"]"));
    assert!(e.contains("Vault reference not allowed here"), "{e}");
    assert!(e.contains("env"), "{e}");
}

#[test]
fn vault_reference_is_rejected_in_title_and_cwd() {
    let e = errors(&GOOD.replace("command = [\"cat\"]", "command = [\"cat\"]\n    title = \"${vault.local.FLEET_TOKEN}\""));
    assert!(e.contains("Vault reference not allowed here"), "{e}");
}

#[test]
fn unknown_vault_name_suggests_the_close_one() {
    let e = errors(&GOOD.replace("${vault.local.FLEET_TOKEN}", "${vault.locl.FLEET_TOKEN}"));
    assert!(e.contains("not declared"), "{e}");
}

#[test]
fn undeclared_secret_key_is_rejected_when_the_vault_declares_its_secrets() {
    let e = errors(&GOOD.replace("${vault.local.FLEET_TOKEN}", "${vault.local.FLEET_TOKN}"));
    assert!(e.contains("does not declare a secret"), "{e}");
}

#[test]
fn unknown_provider_suggests_and_lists_available_ones() {
    let e = errors(&GOOD.replace("provider = \"env\"", "provider = \"dotenvv\""));
    assert!(e.contains("Unknown vault provider") && e.contains("Available"), "{e}");
}

#[test]
fn a_literal_secret_in_the_secrets_map_is_rejected() {
    let e = errors(&GOOD.replace("FLEET_TOKEN = \"FLEET_TOKEN\"", "FLEET_TOKEN = \"sk-live-AbCd/1234+xyz==\""));
    assert!(e.contains("Secrets are never stored"), "{e}");
}

#[test]
fn command_provider_requires_a_command_and_other_providers_ignore_one() {
    let e = errors(&GOOD.replace("provider = \"env\"", "provider = \"command\""));
    assert!(e.contains("command") && e.contains("required"), "{e}");
    // Keys another backend uses are accepted and ignored, so provider = var.x can switch backends.
    let spec = load(&GOOD.replace("provider = \"env\"", "provider = \"env\"\n  command = [\"x\"]\n  path = \"other.env\"")).unwrap();
    assert_eq!(spec.vault("any").unwrap().command, vec!["x".to_owned()]);
}

#[test]
fn one_block_can_switch_backend_with_a_variable() {
    let src = GOOD.replace("vault \"any\" {\n  provider = \"env\"\n}", "variable \"backend\" {\n  default = \"dotenv\"\n}\n\nvault \"any\" {\n  provider = var.backend\n  path = \"x.env\"\n  command = [\"op\", \"read\", \"{ref}\"]\n}");
    assert_eq!(load(&src).unwrap().vault("any").unwrap().provider, "dotenv");
    let mut over = BTreeMap::new();
    over.insert("backend".to_owned(), "command".to_owned());
    assert_eq!(load_str("t.yah", &src, &over).unwrap().vault("any").unwrap().provider, "command");
}

#[test]
fn vault_block_needs_a_label_and_a_provider() {
    let e = errors(&GOOD.replace("vault \"any\" {\n  provider = \"env\"\n}", "vault \"any\" {\n}"));
    assert!(e.contains("Missing required argument"), "{e}");
}

// ---- end to end against a fake h1 -------------------------------------------------------------

fn fake_h1(dir: &Path) -> (PathBuf, PathBuf, PathBuf) {
    let argv_log = dir.join("argv.log");
    let env_log = dir.join("env.log");
    let bin = dir.join("h1");
    let script = format!(
        "#!/bin/sh\necho \"$@\" >> \"{argv}\"\ncase \"$1\" in\nlist) echo '[]' ;;\nconsole) echo SNAPSHOT ;;\nopen) printenv FLEET_TOKEN >> \"{env}\" || echo MISSING >> \"{env}\" ;;\nesac\nexit 0\n",
        argv = argv_log.display(),
        env = env_log.display()
    );
    std::fs::write(&bin, script).unwrap();
    std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
    (bin, argv_log, env_log)
}

fn vault_plan() -> Plan {
    let argv = vec![
        Templ::lit("open"),
        Templ::lit("-n"),
        Templ::lit("alpha"),
        Templ::lit("--env"),
        Templ(vec![Part::Lit("FLEET_TOKEN=".into()), Part::Vault("local".into(), "FLEET_TOKEN".into())]),
        Templ::lit("--env"),
        Templ::lit("PLAIN=visible"),
        Templ::lit("--"),
        Templ::lit("cat"),
    ];
    let step = OpenStep { harness: "alpha".into(), name: "alpha".into(), role: "worker".into(), parent: None, model: "anthropic/claude-haiku-5-5".into(), argv };
    Plan { team: "t".into(), root: "alpha".into(), steps: vec![step], edges: Vec::<Edge>::new() }
}

fn nodes() -> Vec<Node> {
    vec![Node { name: "alpha".into(), harness: "alpha".into(), role: "worker".into(), parent: None, requested_model: "haiku".into(), model: "anthropic/claude-haiku-5-5".into(), model_label: "haiku".into(), pick: PickInfo { via: "pinned".into(), rule: None, reason: "pinned".into(), degraded_level: 0 }, tools: vec![], vault_env: vec![] }]
}

fn all_files_text(dir: &Path) -> String {
    let mut out = String::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        for e in std::fs::read_dir(&d).into_iter().flatten().flatten() {
            let p = e.path();
            if p.is_dir() { stack.push(p) } else if let Ok(s) = std::fs::read_to_string(&p) { out.push_str(&s) }
        }
    }
    out
}

#[test]
fn up_passes_the_secret_in_the_environment_and_never_on_a_command_line() {
    let dir = tempfile::tempdir().unwrap();
    let (bin, argv_log, env_log) = fake_h1(dir.path());
    let home = dir.path().join("home");
    let manifests = dir.path().join("manifests");
    let plan = vault_plan();
    let env = |_: &str| None;
    let vault = |v: &str, k: &str| if (v, k) == ("local", "FLEET_TOKEN") { Ok(SECRET.to_owned()) } else { Err("not found".to_owned()) };
    let req = UpRequest { plan: &plan, nodes: nodes(), source: "/tmp/t.yah".into(), home: home.clone(), manifest_dir: manifests.clone(), run: "t-1-aaaa".into(), now_ms: 1, env: &env, vault: &vault };
    up_core(&req, &ProcessRunner { bin }).unwrap();

    let argv = std::fs::read_to_string(&argv_log).unwrap();
    assert!(!argv.contains(SECRET), "secret leaked into a command line:\n{argv}");
    assert!(argv.contains("PLAIN=visible"), "plain env entries still use --env:\n{argv}");
    assert!(!argv.contains("FLEET_TOKEN"), "the secret entry must not be on the command line at all:\n{argv}");
    assert_eq!(std::fs::read_to_string(&env_log).unwrap().trim(), SECRET, "the program's environment must hold the secret");
    for dir in [&home, &manifests] {
        assert!(!all_files_text(dir).contains(SECRET), "a file written by the run contains the secret");
    }
}

#[test]
fn up_opens_nothing_when_a_secret_cannot_be_fetched() {
    let dir = tempfile::tempdir().unwrap();
    let (bin, argv_log, _env_log) = fake_h1(dir.path());
    let plan = vault_plan();
    let env = |_: &str| None;
    let vault = |_: &str, _: &str| Err("vault \"local\" (dotenv): key \"FLEET_TOKEN\": FLEET_TOKEN is not set in fleet.env".to_owned());
    let req = UpRequest { plan: &plan, nodes: nodes(), source: "/tmp/t.yah".into(), home: dir.path().join("home"), manifest_dir: dir.path().join("m"), run: "t-1-bbbb".into(), now_ms: 1, env: &env, vault: &vault };
    let err = up_core(&req, &ProcessRunner { bin }).unwrap_err();
    assert!(err.contains("FLEET_TOKEN is not set"), "{err}");
    let calls = std::fs::read_to_string(&argv_log).unwrap_or_default();
    assert!(!calls.contains("open "), "no lab may be opened when a secret is missing:\n{calls}");
}

#[test]
fn the_plan_line_shows_the_reference_never_a_value() {
    let shell = vault_plan().steps[0].shell();
    assert!(shell.contains("${vault.local.FLEET_TOKEN}"), "{shell}");
    assert!(!shell.contains(SECRET));
}

#[test]
fn vaults_resolver_reads_a_dotenv_file_next_to_the_yah() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("fleet.env"), format!("FLEET_TOKEN={SECRET}\n")).unwrap();
    let spec = load(GOOD).unwrap();
    let env = |_: &str| None;
    let vaults = Vaults::new(&spec.vaults, dir.path().to_path_buf(), &env);
    assert_eq!(vaults.get("local", "FLEET_TOKEN").unwrap(), SECRET);
    let err = vaults.get("local", "GH_TOKEN").unwrap_err();
    assert!(err.contains("GITHUB_TOKEN is not set"), "{err}");
    assert!(!err.contains(SECRET));
}

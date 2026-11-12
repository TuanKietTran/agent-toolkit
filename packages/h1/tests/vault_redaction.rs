//! H2 (hardening backlog): provider failure redaction. A failing external provider CLI must
//! never echo the secret it was fetching — not on stderr, not in malformed stdout, not before
//! a timeout. Surfaces: the fetch itself (`Vaults::get`, the path `vault status --fetch`
//! calls) and `h1 up` (`up_core` against a fake h1). Every failure must be clean:
//! an error naming the provider, no secret anywhere in the error / argv / written files,
//! and no lab opened.
//!
//! H2b: the `command` arm originally had its own failure path (`run_command` quoted the
//! first line of stderr, scrubbed only against already-cached values), so a command
//! provider leaked while the CLI providers were clean. `run_command` is now the ONE
//! shared failure path for every external arm. The command-arm tests below use the
//! commander's reproduction marker (`value was: LEAKME-s3cr3t-9981` on stderr, exit 1)
//! through both surfaces on this branch — `Vaults::get` and `up_core`; `cli.rs` here has
//! no `vault status` or `--dry-run` subcommand, those surfaces on the merged tree call
//! the same `Vaults::get` / render path. dotenv/env run no program, so they have no
//! provider output to quote.

#![cfg(unix)]

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use std::collections::BTreeMap;

use h1::yah::cli::{
    ProcessRunner, UpOutcome, UpRequest, check_line, graph_output, plan_json, plan_output,
    render_diags, up_core,
};
use h1::yah::load::load_str;
use h1::yah::manifest::{Edge, Node, PickInfo};
use h1::yah::pick::{Resolved, Via};
use h1::yah::plan::{OpenStep, Plan, PlanOpts};
use h1::yah::spec::{Part, Templ, Vault};
use h1::yah::vault::Vaults;

const SECRET_A: &str = "H2-FAKE-SECRET-stderr-7f3a9c";
const SECRET_B: &str = "H2-FAKE-SECRET-framing-5b2d8e";
const SECRET_C: &str = "H2-FAKE-SECRET-hang-91c4f0";
/// The Claude commander's H2b reproduction marker, printed as `value was: <marker>`.
const SECRET_CMD: &str = "LEAKME-s3cr3t-9981";
/// H9: a credential embedded as an inline argument in a provider `command` override.
const MARKER_CMD: &str = "MARKERCMD9981";

/// (provider, real program name the fake is named after)
const CLI_PROVIDERS: [(&str, &str); 4] = [
    ("1password", "op"),
    ("bitwarden", "bw"),
    ("bitwarden-secrets", "bws"),
    ("keychain", "security"),
];

fn reference(provider: &str) -> &'static str {
    match provider {
        "1password" => "op://vault/item/field",
        "bitwarden" => "myitem",
        "bitwarden-secrets" => "secret-id-123",
        "keychain" => "myservice",
        "command" => "cmd-ref",
        other => panic!("no reference for {other}"),
    }
}

fn write_script(dir: &Path, name: &str, body: &str) -> PathBuf {
    let p = dir.join(name);
    fs::write(&p, format!("#!/bin/sh\n{body}\n")).unwrap();
    fs::set_permissions(&p, fs::Permissions::from_mode(0o755)).unwrap();
    p
}

fn cli_vault(provider: &str, bin: &Path, reference: &str) -> Vault {
    Vault {
        name: "v".into(),
        provider: provider.into(),
        path: None,
        account: None,
        command: vec![bin.to_string_lossy().into_owned()],
        plugin: None,
        options: Vec::new(),
        secrets: vec![("TOKEN".into(), reference.into())],
        line: 1,
    }
}

fn fetch(v: &Vault, timeout: Duration) -> Result<String, String> {
    let vs = std::slice::from_ref(v);
    let env = |_: &str| -> Option<String> { None };
    Vaults::new(vs, PathBuf::from("."), &env)
        .with_timeout(timeout)
        .get("v", "TOKEN")
}

/// Fake h1 from vault_up_e2e: records argv, records env on open.
fn fake_h1(dir: &Path) -> (PathBuf, PathBuf, PathBuf) {
    let argv_log = dir.join("argv.log");
    let env_log = dir.join("env.log");
    let bin = dir.join("h1");
    let script = format!(
        "#!/bin/sh\necho \"$@\" >> \"{argv}\"\ncase \"$1\" in\nlist) echo '[]' ;;\nconsole) echo SNAPSHOT ;;\nopen) printenv >> \"{env}\" ;;\nesac\nexit 0\n",
        argv = argv_log.display(),
        env = env_log.display()
    );
    fs::write(&bin, script).unwrap();
    fs::set_permissions(&bin, fs::Permissions::from_mode(0o755)).unwrap();
    (bin, argv_log, env_log)
}

fn plan() -> Plan {
    let argv = vec![
        Templ::lit("open"),
        Templ::lit("-n"),
        Templ::lit("alpha"),
        Templ::lit("--env"),
        Templ(vec![
            Part::Lit("FLEET_TOKEN=".into()),
            Part::Vault("v".into(), "TOKEN".into()),
        ]),
        Templ::lit("--"),
        Templ::lit("cat"),
    ];
    let step = OpenStep {
        harness: "alpha".into(),
        name: "alpha".into(),
        role: "worker".into(),
        parent: None,
        model: "anthropic/claude-haiku-5-5".into(),
        argv,
    };
    Plan {
        team: "t".into(),
        root: "alpha".into(),
        steps: vec![step],
        edges: Vec::<Edge>::new(),
    }
}

fn nodes() -> Vec<Node> {
    vec![Node {
        name: "alpha".into(),
        harness: "alpha".into(),
        role: "worker".into(),
        parent: None,
        requested_model: "haiku".into(),
        model: "anthropic/claude-haiku-5-5".into(),
        model_label: "haiku".into(),
        pick: PickInfo {
            via: "pinned".into(),
            rule: None,
            reason: "pinned".into(),
            degraded_level: 0,
        },
        tools: vec![],
        vault_env: Vec::new(),
    }]
}

fn all_files_text(dir: &Path) -> String {
    let mut out = String::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        if let Ok(entries) = fs::read_dir(&d) {
            for e in entries.flatten() {
                let p = e.path();
                if p.is_dir() {
                    stack.push(p);
                } else if let Ok(bytes) = fs::read(&p) {
                    out.push_str(&String::from_utf8_lossy(&bytes));
                }
            }
        }
    }
    out
}

struct UpRun {
    result: Result<UpOutcome, String>,
    argv_log: PathBuf,
    home: PathBuf,
    manifests: PathBuf,
}

fn run_up(dir: &Path, vaults: &[Vault], timeout: Duration) -> UpRun {
    let home = dir.join("home");
    let manifests = dir.join("manifests");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&manifests).unwrap();
    let (bin, argv_log, _env_log) = fake_h1(dir);
    let plan = plan();
    let nodes = nodes();
    let env_fn = |_: &str| -> Option<String> { None };
    let vaults_ref = Vaults::new(vaults, dir.to_path_buf(), &env_fn).with_timeout(timeout);
    let vault_fn = |v: &str, k: &str| vaults_ref.get(v, k);
    let req = UpRequest {
        plan: &plan,
        nodes,
        source: "/tmp/t.yah".into(),
        home: home.clone(),
        manifest_dir: manifests.clone(),
        run: "t-1-aaaa".into(),
        now_ms: 1,
        env: &env_fn,
        vault: &vault_fn,
    };
    let result = up_core(&req, &ProcessRunner { bin });
    UpRun {
        result,
        argv_log,
        home,
        manifests,
    }
}

fn assert_up_clean(run: &UpRun, provider: &str, secret: &str) -> String {
    let err = match &run.result {
        Ok(_) => panic!("{provider}: up unexpectedly succeeded"),
        Err(e) => e.clone(),
    };
    assert!(
        err.contains(provider),
        "{provider}: up error does not name the provider: {err}"
    );
    assert!(
        !err.contains(secret),
        "{provider}: SECRET LEAKED into up error: {err}"
    );
    let argv = fs::read_to_string(&run.argv_log).unwrap_or_default();
    assert!(
        !argv.contains("open"),
        "{provider}: a lab was opened despite the failed fetch:\n{argv}"
    );
    assert!(
        !argv.contains(secret),
        "{provider}: secret in recorded argv:\n{argv}"
    );
    for d in [&run.home, &run.manifests] {
        assert!(
            !all_files_text(d).contains(secret),
            "{provider}: secret in a file under {}",
            d.display()
        );
    }
    err
}

#[test]
fn a_stderr_secret_is_never_echoed() {
    for (provider, prog) in CLI_PROVIDERS {
        let dir = tempfile::tempdir().unwrap();
        let bin = write_script(dir.path(), prog, &format!("echo '{SECRET_A}' >&2; exit 1"));
        let err = fetch(
            &cli_vault(provider, &bin, reference(provider)),
            Duration::from_secs(5),
        )
        .unwrap_err();
        assert!(
            err.contains(provider),
            "{provider}: fetch error does not name the provider: {err}"
        );
        assert!(
            err.contains("exit status: 1"),
            "{provider}: fetch error does not name the exit status: {err}"
        );
        assert!(
            !err.contains(SECRET_A),
            "{provider}: SECRET LEAKED into fetch error: {err}"
        );
        let run = run_up(
            dir.path(),
            &[cli_vault(provider, &bin, reference(provider))],
            Duration::from_secs(5),
        );
        assert_up_clean(&run, provider, SECRET_A);
    }
    // H2b: the `command` arm — the commander's reproduction. Same leaky fake shape,
    // marker framed as `value was: <marker>` on stderr, exit 1. Fetch first:
    let dir = tempfile::tempdir().unwrap();
    let bin = write_script(
        dir.path(),
        "leaky-cmd",
        &format!("echo 'value was: {SECRET_CMD}' >&2; exit 1"),
    );
    let err = fetch(
        &cli_vault("command", &bin, reference("command")),
        Duration::from_secs(5),
    )
    .unwrap_err();
    assert!(
        err.contains("command"),
        "command: fetch error does not name the provider: {err}"
    );
    assert!(
        err.contains("leaky-cmd") && err.contains("exit status: 1"),
        "command: fetch error must name program + exit status only: {err}"
    );
    assert!(
        !err.contains(SECRET_CMD),
        "command: SECRET LEAKED into fetch error: {err}"
    );
    assert!(
        !err.contains("value was"),
        "command: provider stderr was quoted in fetch error: {err}"
    );
    // Then the up surface:
    let run = run_up(
        dir.path(),
        &[cli_vault("command", &bin, reference("command"))],
        Duration::from_secs(5),
    );
    let up_err = assert_up_clean(&run, "command", SECRET_CMD);
    assert!(
        up_err.contains("exit status: 1"),
        "command: up error must carry the exit status: {up_err}"
    );
    assert!(
        !up_err.contains("value was"),
        "command: provider stderr was quoted in up error: {up_err}"
    );
    // The same fake printing the marker on STDOUT and exiting 1: a non-zero exit never
    // quotes stdout either.
    let dir = tempfile::tempdir().unwrap();
    let bin = write_script(
        dir.path(),
        "leaky-cmd",
        &format!("echo 'value was: {SECRET_CMD}'; exit 1"),
    );
    let err = fetch(
        &cli_vault("command", &bin, reference("command")),
        Duration::from_secs(5),
    )
    .unwrap_err();
    assert!(
        err.contains("exit status: 1"),
        "command: fetch error must name the exit status: {err}"
    );
    assert!(
        !err.contains(SECRET_CMD) && !err.contains("value was"),
        "command: SECRET LEAKED via stdout into fetch error: {err}"
    );
}

#[test]
fn b_malformed_stdout_secret_is_never_echoed() {
    // bws: stdout is the secret as plain text, not the JSON framing it must return.
    let dir = tempfile::tempdir().unwrap();
    let bin = write_script(dir.path(), "bws", &format!("echo '{SECRET_B}'; exit 0"));
    let err = fetch(
        &cli_vault("bitwarden-secrets", &bin, "secret-id-123"),
        Duration::from_secs(5),
    )
    .unwrap_err();
    assert!(err.contains("bitwarden-secrets"), "{err}");
    assert!(
        !err.contains(SECRET_B),
        "SECRET LEAKED into fetch error: {err}"
    );
    let run = run_up(
        dir.path(),
        &[cli_vault("bitwarden-secrets", &bin, "secret-id-123")],
        Duration::from_secs(5),
    );
    assert_up_clean(&run, "bitwarden-secrets", SECRET_B);
    // bws: valid JSON, but the secret sits in another field and there is no string `value`.
    let dir = tempfile::tempdir().unwrap();
    let bin = write_script(
        dir.path(),
        "bws",
        &format!("echo '{{\"id\":\"x\",\"other\":\"{SECRET_B}\"}}'; exit 0"),
    );
    let err = fetch(
        &cli_vault("bitwarden-secrets", &bin, "secret-id-123"),
        Duration::from_secs(5),
    )
    .unwrap_err();
    assert!(
        !err.contains(SECRET_B),
        "SECRET LEAKED into fetch error: {err}"
    );
    // bw #field: valid JSON item whose only field value is the secret, under another name.
    let dir = tempfile::tempdir().unwrap();
    let bin = write_script(
        dir.path(),
        "bw",
        &format!("echo '{{\"fields\":[{{\"name\":\"other\",\"value\":\"{SECRET_B}\"}}]}}'; exit 0"),
    );
    let err = fetch(
        &cli_vault("bitwarden", &bin, "myitem#api_key"),
        Duration::from_secs(5),
    )
    .unwrap_err();
    assert!(err.contains("api_key"), "{err}");
    assert!(
        !err.contains(SECRET_B),
        "SECRET LEAKED into fetch error: {err}"
    );
    // bw #field: stdout is the secret as plain text, not JSON at all.
    let dir = tempfile::tempdir().unwrap();
    let bin = write_script(dir.path(), "bw", &format!("echo '{SECRET_B}'; exit 0"));
    let err = fetch(
        &cli_vault("bitwarden", &bin, "myitem#api_key"),
        Duration::from_secs(5),
    )
    .unwrap_err();
    assert!(
        !err.contains(SECRET_B),
        "SECRET LEAKED into fetch error: {err}"
    );
}

#[test]
fn c_hanging_provider_times_out_cleanly() {
    for (provider, prog) in CLI_PROVIDERS {
        let dir = tempfile::tempdir().unwrap();
        let bin = write_script(dir.path(), prog, &format!("echo '{SECRET_C}' >&2; sleep 5"));
        let started = Instant::now();
        let err = fetch(
            &cli_vault(provider, &bin, reference(provider)),
            Duration::from_millis(300),
        )
        .unwrap_err();
        assert!(
            started.elapsed() < Duration::from_secs(3),
            "{provider}: fetch hung past the timeout: {:?}",
            started.elapsed()
        );
        assert!(err.contains("did not finish"), "{provider}: {err}");
        assert!(
            !err.contains(SECRET_C),
            "{provider}: SECRET LEAKED into fetch error: {err}"
        );
    }
    // H2b: the `command` arm hangs the same way — clean timeout, no marker.
    let dir = tempfile::tempdir().unwrap();
    let bin = write_script(
        dir.path(),
        "leaky-cmd",
        &format!("echo '{SECRET_CMD}' >&2; sleep 5"),
    );
    let started = Instant::now();
    let err = fetch(
        &cli_vault("command", &bin, reference("command")),
        Duration::from_millis(300),
    )
    .unwrap_err();
    assert!(
        started.elapsed() < Duration::from_secs(3),
        "command: fetch hung past the timeout: {:?}",
        started.elapsed()
    );
    assert!(err.contains("did not finish"), "command: {err}");
    assert!(
        !err.contains(SECRET_CMD),
        "command: SECRET LEAKED into fetch error: {err}"
    );
    // up surface, one provider: render must fail at the timeout, no lab opened, no leak.
    let dir = tempfile::tempdir().unwrap();
    let bin = write_script(dir.path(), "op", &format!("echo '{SECRET_C}' >&2; sleep 5"));
    let started = Instant::now();
    let run = run_up(
        dir.path(),
        &[cli_vault("1password", &bin, reference("1password"))],
        Duration::from_millis(300),
    );
    assert!(
        started.elapsed() < Duration::from_secs(3),
        "up hung past the timeout: {:?}",
        started.elapsed()
    );
    assert_up_clean(&run, "1password", SECRET_C);
}

#[test]
fn d_provider_command_string_is_never_rendered() {
    // H9: a provider `command` override is config that can embed a credential as an
    // inline argument (`--token MARKERCMD9981`); it must be rendered like a secret
    // everywhere — program name only, never the full command string. This branch has
    // no `vault status` or `up --dry-run` subcommand (see the H2b note above): the
    // check/plan/graph functions below ARE those surfaces, and the failing fetch is
    // the path `vault status --fetch` uses on the merged tree.
    let dir = tempfile::tempdir().unwrap();
    let bin = write_script(dir.path(), "cmdprog", "echo 'provider blew up' >&2; exit 1");
    let bin_str = bin.to_string_lossy().into_owned();
    let marker_vault = Vault {
        name: "v".into(),
        provider: "command".into(),
        path: None,
        account: None,
        command: vec![
            bin_str.clone(),
            "--token".into(),
            MARKER_CMD.into(),
            "{ref}".into(),
        ],
        plugin: None,
        options: Vec::new(),
        secrets: vec![("TOKEN".into(), "cmd-ref".into())],
        line: 1,
    };
    // Failing fetch (Vaults::get): names provider + program + exit status only.
    let err = fetch(&marker_vault, Duration::from_secs(5)).unwrap_err();
    assert!(
        err.contains("command"),
        "command: fetch error does not name the provider: {err}"
    );
    assert!(
        err.contains("cmdprog") && err.contains("exit status: 1"),
        "command: fetch error must name program + exit status only: {err}"
    );
    assert!(
        !err.contains(MARKER_CMD),
        "command: MARKER LEAKED into fetch error: {err}"
    );
    assert!(
        !err.contains("--token"),
        "command: command string leaked into fetch error: {err}"
    );
    // `h1 up` via the fake h1: same clean failure, no lab opened, no file written.
    let run = run_up(dir.path(), &[marker_vault], Duration::from_secs(5));
    let up_err = assert_up_clean(&run, "command", MARKER_CMD);
    assert!(
        up_err.contains("cmdprog") && up_err.contains("exit status: 1"),
        "command: up error must name program + exit status only: {up_err}"
    );
    assert!(
        !up_err.contains("--token"),
        "command: command string leaked into up error: {up_err}"
    );
    // check / plan / graph from a real .yah whose vault command carries the marker.
    let src = r#"yah 1

vault "v" {
  provider = "command"
  command  = ["__BIN__", "--token", "MARKERCMD9981", "{ref}"]
  secrets  = {
    TOKEN = "cmd-ref"
  }
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
      FLEET_TOKEN = "${vault.v.TOKEN}"
    }
  }
}

team "t" {
  root    = "alpha"
  members = []
}
"#
    .replace("__BIN__", &bin_str);
    let spec = load_str("t.yah", &src, &BTreeMap::new())
        .map_err(|d| render_diags(&d))
        .unwrap();
    // Sanity: the marker really is in the loaded config, so the checks below are not vacuous.
    assert!(
        spec.vault("v")
            .unwrap()
            .command
            .iter()
            .any(|a| a == MARKER_CMD),
        "marker missing from the loaded vault command"
    );
    let checked = check_line(spec.harnesses.len(), spec.teams.len());
    assert!(
        !checked.contains(MARKER_CMD),
        "check LEAKED the marker: {checked}"
    );
    let resolved = vec![Resolved {
        harness: "alpha".into(),
        requested: "haiku".into(),
        label: "haiku".into(),
        id: "claude-haiku-5-5".into(),
        provider_type: "anthropic".into(),
        via: Via::Pinned,
        rule: None,
        reason: "pinned".into(),
        degraded_level: 0,
    }];
    let opts = PlanOpts {
        prefix: None,
        run: "t-1-aaaa".into(),
        trace_dir: None,
        detached: false,
    };
    let built = h1::yah::plan::build(&spec, "t", &resolved, &opts)
        .map_err(|d| render_diags(&d))
        .unwrap();
    let surfaces = [
        ("plan", plan_output(&built, &resolved)),
        ("plan --json", plan_json(&built, &resolved).to_string()),
        (
            "graph",
            graph_output(spec.team("t").unwrap(), &built, &resolved),
        ),
    ];
    for (name, out) in surfaces {
        assert!(
            !out.contains(MARKER_CMD),
            "{name} LEAKED the marker:\n{out}"
        );
        assert!(
            !out.contains("--token"),
            "{name} LEAKED the provider command string:\n{out}"
        );
    }
}

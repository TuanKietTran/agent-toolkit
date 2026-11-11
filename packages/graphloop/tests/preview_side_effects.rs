//! Side-effect-free preview test (pv-qa #5).
//!
//! The contract in `src/preview.rs`: producing a preview NEVER spawns a
//! process (system-one included), never writes a run manifest, never
//! touches `~/.h1` or the session dir, never fetches a vault secret and
//! never expands `${env.*}`. This test enforces all of that against the
//! real binary, in the isolated style of `envfile_no_leak.rs`:
//!
//! - `H1_BIN` and a `system-one` on PATH are fakes that append every
//!   invocation to a log file; the log must not exist after the run.
//! - `GRAPHLOOP_HOME`, `H1_DIR` and `HOME` point at paths that are never
//!   created beforehand; they must still not exist after the run.
//! - The spec references a dotenv vault whose file holds a fake sentinel
//!   secret and an `${env.*}` var whose process value is a second fake
//!   sentinel; neither sentinel may appear in stdout/stderr, and the
//!   parsed `Preview` must carry the references as written.
//! - A recursive file listing of the whole temp root is identical
//!   before and after the run.
//!
//! Gated like `preview_cli_matches_goldens_when_available`: if this
//! binary has no `preview` subcommand, the test prints
//! `PREVIEW_SKIPPED` and passes.

use std::path::{Path, PathBuf};
use std::process::Command;

use graphloop::preview::Preview;

const VAULT_SENTINEL: &str = "FAKE_VAULT_SENTINEL_67890";
const ENV_SENTINEL: &str = "FAKE_ENV_SENTINEL_ABCDE";

fn tree(root: &Path) -> Vec<String> {
    fn walk(dir: &Path, root: &Path, out: &mut Vec<String>) {
        let mut entries: Vec<PathBuf> = std::fs::read_dir(dir)
            .unwrap()
            .filter_map(|e| e.ok().map(|e| e.path()))
            .collect();
        entries.sort();
        for p in entries {
            out.push(p.strip_prefix(root).unwrap().to_string_lossy().into_owned());
            if p.is_dir() {
                walk(&p, root, out);
            }
        }
    }
    let mut out = Vec::new();
    walk(root, root, &mut out);
    out
}

fn make_fake(dir: &Path, name: &str, log: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let bin = dir.join(name);
    std::fs::write(
        &bin,
        format!(
            "#!/bin/sh\nprintf '%s %s\\n' \"$0\" \"$@\" >> '{}'\nexit 0\n",
            log.display()
        ),
    )
    .unwrap();
    std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
}

#[cfg(unix)]
#[test]
fn preview_spawns_nothing_writes_nothing_and_fetches_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let fleet = root.join("fleet.env");
    std::fs::write(&fleet, format!("PREVIEW_TOKEN={VAULT_SENTINEL}\n")).unwrap();
    let spec = format!(
        "yah 1\n\ndefaults {{ model_policy = \"system-one\" sandbox = \"local\" }}\nprovider \"anthropic\" {{ type = \"anthropic\" }}\nmodel \"sonnet\" {{ provider = \"anthropic\" id = \"claude-sonnet-5-5\" capabilities = [\"chat\"] }}\nsystem_one {{ fallback = \"sonnet\" }}\nvault \"local\" {{ provider = \"dotenv\" path = \"{}\" secrets = {{ PREVIEW_TOKEN = \"PREVIEW_TOKEN\" }} }}\nharness \"lead\" {{ kind = \"h1\" role = \"lead\" model = \"system-one\" open {{ command = [\"cat\"] detached = true env = {{ PREVIEW_TOKEN = \"${{vault.local.PREVIEW_TOKEN}}\" GREETING = \"${{env.PREVIEW_GREETING}}\" }} }} }}\nteam \"se\" {{ root = \"lead\" members = [] }}\n",
        fleet.display()
    );
    let yah = root.join("preview-se.yah");
    std::fs::write(&yah, spec).unwrap();
    let bin_dir = root.join("bin");
    std::fs::create_dir(&bin_dir).unwrap();
    let log = root.join("spawned.log");
    make_fake(&bin_dir, "h1", &log);
    make_fake(&bin_dir, "system-one", &log);
    let home = root.join("glhome");
    let h1_dir = root.join("h1dir");
    let fake_home = root.join("fakehome");
    let before = tree(root);
    let out = Command::new(env!("CARGO_BIN_EXE_graphloop"))
        .args(["preview", "preview-se.yah"])
        .current_dir(root)
        .env("GRAPHLOOP_HOME", &home)
        .env("H1_DIR", &h1_dir)
        .env("H1_BIN", bin_dir.join("h1"))
        .env("HOME", &fake_home)
        .env(
            "PATH",
            format!(
                "{}:{}",
                bin_dir.display(),
                std::env::var("PATH").unwrap_or_default()
            ),
        )
        .env("PREVIEW_GREETING", ENV_SENTINEL)
        .output()
        .unwrap();
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).into_owned();
        if err.contains("unrecognized")
            || err.contains("unexpected argument")
            || err.contains("USAGE")
            || err.contains("Usage")
        {
            eprintln!(
                "PREVIEW_SKIPPED: preview subcommand not in this binary yet: {}",
                err.lines().next().unwrap_or("")
            );
            return;
        }
        panic!("preview failed for another reason: {err}");
    }
    let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
    let combined = format!("{stdout}{}", String::from_utf8_lossy(&out.stderr));
    assert!(
        !combined.contains(VAULT_SENTINEL),
        "preview fetched/expanded the vault secret: {combined}"
    );
    assert!(
        !combined.contains(ENV_SENTINEL),
        "preview expanded ${{env.PREVIEW_GREETING}}: {combined}"
    );
    let p: Preview = serde_json::from_str(&stdout)
        .unwrap_or_else(|e| panic!("preview output does not parse as Preview: {e}"));
    assert_eq!(p.team, "se");
    assert_eq!(p.nodes.len(), 1);
    let values: Vec<&str> = p.nodes[0].env.iter().map(|e| e.value.as_str()).collect();
    assert!(
        values.contains(&"${vault.local.PREVIEW_TOKEN}"),
        "vault reference not carried as written: {values:?}"
    );
    assert!(
        values.contains(&"${env.PREVIEW_GREETING}"),
        "env reference not carried as written: {values:?}"
    );
    assert!(
        !log.exists(),
        "preview spawned a process: {}",
        std::fs::read_to_string(&log).unwrap_or_default()
    );
    assert!(!home.exists(), "preview created GRAPHLOOP_HOME");
    assert!(!h1_dir.exists(), "preview created H1_DIR");
    assert!(!fake_home.exists(), "preview touched HOME");
    assert_eq!(tree(root), before, "preview changed the file tree");
}

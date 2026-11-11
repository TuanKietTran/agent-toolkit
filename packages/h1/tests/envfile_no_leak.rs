//! H3: a secret loaded via `--env-file` is never printed by any read-only command.
//!
//! Builds a one-harness `cat` spec whose `open.env` references `${env.LEAK_KEY}`,
//! loads the fixed fake value `FAKE_LEAK_SENTINEL_12345` from an explicit
//! `--env-file`, then runs the real binary for `plan`, `graph`, `up --dry-run`,
//! `runs`, `trace` and `down` in isolated `GRAPHLOOP_HOME` / `H1_DIR` temp dirs
//! (with a fake `h1` on `H1_BIN`, so no real lab is ever touched). The sentinel
//! value must appear in NO command's stdout or stderr, while `plan` and
//! `up --dry-run` must still print the env NAME `LEAK_KEY`.

use std::path::{Path, PathBuf};
use std::process::{Command, Output};

const SENTINEL: &str = "FAKE_LEAK_SENTINEL_12345";
const RUN: &str = "leakrun";

const SPEC: &str = r##"yah 1

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
    command  = ["cat"]
    detached = true
    env = {
      LEAK_KEY = "${env.LEAK_KEY}"
    }
  }
}

team "t" {
  root    = "alpha"
  members = []
}
"##;

struct Iso {
    home: PathBuf,
    h1_dir: PathBuf,
    h1_bin: PathBuf,
}

fn run_cli(iso: &Iso, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_graphloop"))
        .args(args)
        .env("GRAPHLOOP_HOME", &iso.home)
        .env("H1_DIR", &iso.h1_dir)
        .env("H1_BIN", &iso.h1_bin)
        .env_remove("LEAK_KEY")
        .output()
        .unwrap()
}

fn combined(out: &Output) -> String {
    format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr))
}

fn assert_clean(cmd: &str, out: &Output) -> String {
    let text = combined(out);
    assert!(out.status.success(), "{cmd} failed: {text}");
    assert!(!text.contains(SENTINEL), "{cmd} LEAKED the --env-file value: {text}");
    text
}

#[cfg(unix)]
fn make_fake_h1(dir: &Path) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let bin = dir.join("h1");
    std::fs::write(&bin, "#!/bin/sh\ncase \"$1\" in\nlist) printf '%s' '[{\"name\":\"alpha\"}]' ;;\nesac\nexit 0\n").unwrap();
    std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
    bin
}

#[cfg(unix)]
#[test]
fn env_file_secret_never_printed_by_read_only_commands() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let yah = root.join("leak.yah");
    std::fs::write(&yah, SPEC).unwrap();
    let env_file = root.join("secret.env");
    std::fs::write(&env_file, format!("LEAK_KEY={SENTINEL}\n")).unwrap();
    let yah_s = yah.display().to_string();
    let env_s = env_file.display().to_string();
    let iso = Iso { home: root.join("glhome"), h1_dir: root.join("h1dir"), h1_bin: make_fake_h1(root) };

    // plan: prints the env NAME (unexpanded ${env.LEAK_KEY}), never the value.
    let out = run_cli(&iso, &["plan", &yah_s, "--env-file", &env_s]);
    let text = assert_clean("plan", &out);
    assert!(text.contains("LEAK_KEY"), "plan must name the env var: {text}");

    // graph: no value either.
    let out = run_cli(&iso, &["graph", &yah_s, "--env-file", &env_s]);
    assert_clean("graph", &out);

    // up --dry-run: renders fully (secret is fetched) but prints names only,
    // and stays side-effect free (no home, no registry created).
    let out = run_cli(&iso, &["up", &yah_s, "--env-file", &env_s, "--dry-run"]);
    let text = assert_clean("up --dry-run", &out);
    assert!(text.contains("LEAK_KEY"), "up --dry-run must name the env var: {text}");
    assert!(!iso.home.exists(), "dry-run created GRAPHLOOP_HOME");
    assert!(!iso.h1_dir.exists(), "dry-run created H1_DIR");

    // Seed a run manifest + trace recording for runs/trace/down. The manifest
    // carries env NAMES only (vault_env), never values.
    let trace_dir = iso.home.join("runs").join(RUN).join("trace");
    std::fs::create_dir_all(&trace_dir).unwrap();
    std::fs::write(trace_dir.join("alpha.jsonl"), "12345").unwrap();
    let graphs = iso.h1_dir.join("graphs");
    std::fs::create_dir_all(&graphs).unwrap();
    let manifest = format!(
        "{{\"version\":1,\"run\":\"{RUN}\",\"team\":\"t\",\"source\":\"{yah}\",\"root\":\"alpha\",\"created_ms\":1700000000000,\"trace_dir\":\"{trace}\",\"nodes\":[{{\"name\":\"alpha\",\"harness\":\"alpha\",\"role\":\"worker\",\"parent\":null,\"requested_model\":\"haiku\",\"model\":\"anthropic/claude-haiku-5-5\",\"model_label\":\"haiku\",\"pick\":{{\"via\":\"pinned\",\"rule\":null,\"reason\":\"pinned\",\"degraded_level\":0}},\"tools\":[],\"vault_env\":[]}}],\"edges\":[]}}",
        yah = yah_s,
        trace = trace_dir.display(),
    );
    assert!(!manifest.contains(SENTINEL));
    let manifest_path = graphs.join(format!("{RUN}.json"));
    std::fs::write(&manifest_path, manifest).unwrap();

    // runs: table over the seeded manifest, live set from the fake h1 list.
    let out = run_cli(&iso, &["runs"]);
    let text = assert_clean("runs", &out);
    assert!(text.contains(RUN), "runs must list the seeded run: {text}");

    // trace: lists the seeded recording with its size and node.
    let out = run_cli(&iso, &["trace", RUN]);
    let text = assert_clean("trace", &out);
    assert!(text.contains("alpha.jsonl"), "trace must list the recording: {text}");

    // down --run: stops the (fake) lab and removes the manifest.
    let out = run_cli(&iso, &["down", "--run", RUN]);
    let text = assert_clean("down", &out);
    assert!(text.contains("alpha"), "down must report the stopped lab: {text}");
    assert!(!manifest_path.exists(), "down must remove the manifest");
}

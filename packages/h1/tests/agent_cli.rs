//! Agent start and adopt commands, black-box through the real binary.
//!
//! `h1 claude|pi|opencode|codex` starts that program in a named h1 session, with anything
//! after `--` passed through to the program. `h1 adopt <PID|NAME>` and
//! `h1 attach --agent <PID|NAME>` resume a running agent's session inside a new h1 session.
//!
//! The start test never runs a real agent CLI: a temp bin dir holds a fake `claude`
//! executable that prints `FAKE_CLAUDE_READY`, records its argv (one argument per line) in
//! the file named by `FAKE_AGENT_ARGS`, then stays alive until its session is stopped.
//! The dir is prepended to `PATH` for the h1 invocation, and `H1_DIR` points at a private
//! temp dir, following the harness pattern in `tests/session.rs`.
//!
//! These tests are written against the start/adopt CLI surface; on a tree without that
//! surface they fail (unknown subcommand / unexpected argument), which is expected.

use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Output, Stdio},
    thread,
    time::{Duration, Instant},
};

/// Generous, as in `tests/session.rs`: only reached when a test fails.
const TIMEOUT: Duration = Duration::from_secs(60);

fn binary() -> &'static str {
    env!("CARGO_BIN_EXE_h1")
}

fn wait_until(mut condition: impl FnMut() -> bool) {
    let start = Instant::now();
    while !condition() {
        assert!(start.elapsed() < TIMEOUT, "condition timed out");
        thread::sleep(Duration::from_millis(30));
    }
}

fn stdout(output: &Output) -> String {
    String::from_utf8_lossy(&output.stdout).into_owned()
}

fn combined(output: &Output) -> String {
    format!(
        "{}{}",
        stdout(output),
        String::from_utf8_lossy(&output.stderr)
    )
}

/// Installs the fake `claude` executable into `bin_dir`.
#[cfg(unix)]
fn install_fake_claude(bin_dir: &Path) {
    use std::os::unix::fs::PermissionsExt;

    let script = bin_dir.join("claude");
    fs::write(
        &script,
        "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$FAKE_AGENT_ARGS\"\necho FAKE_CLAUDE_READY\nwhile :; do sleep 5; done\n",
    )
    .unwrap();
    fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
}

/// The fake-agent start test is unix-only; this stub keeps the file compiling elsewhere.
#[cfg(not(unix))]
fn install_fake_claude(_bin_dir: &Path) {}

/// An isolated `H1_DIR`, a temp bin dir holding the fake agent, and the argv file the fake
/// writes. The session started through the fake is stopped by the test itself.
struct Lab {
    _directory: tempfile::TempDir,
    h1_dir: PathBuf,
    bin_dir: PathBuf,
    args_file: PathBuf,
}

impl Lab {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let h1_dir = directory.path().join("h1");
        let bin_dir = directory.path().join("bin");
        fs::create_dir_all(&h1_dir).unwrap();
        fs::create_dir_all(&bin_dir).unwrap();
        install_fake_claude(&bin_dir);
        Self {
            args_file: directory.path().join("fake-argv.txt"),
            _directory: directory,
            h1_dir,
            bin_dir,
        }
    }

    fn command(&self, args: &[&str]) -> Command {
        let mut paths = vec![self.bin_dir.clone()];
        if let Some(existing) = std::env::var_os("PATH") {
            paths.extend(std::env::split_paths(&existing));
        }
        let mut command = Command::new(binary());
        command
            .env("H1_DIR", &self.h1_dir)
            .env("PATH", std::env::join_paths(paths).unwrap())
            .env("FAKE_AGENT_ARGS", &self.args_file)
            .env_remove("H1_SOCKET")
            .env_remove("H1_NAME");
        command.args(args);
        command
    }

    fn cli(&self, args: &[&str]) -> Output {
        self.command(args).stdin(Stdio::null()).output().unwrap()
    }
}

#[cfg(unix)]
#[test]
fn start_detached() {
    let lab = Lab::new();

    let started = lab.cli(&[
        "claude",
        "--detached",
        "-n",
        "fake1",
        "--",
        "--model",
        "test-x",
    ]);
    assert!(
        started.status.success(),
        "h1 claude --detached failed: {}",
        combined(&started)
    );

    wait_until(|| stdout(&lab.cli(&["list"])).contains("fake1"));
    wait_until(|| stdout(&lab.cli(&["screen", "-n", "fake1"])).contains("FAKE_CLAUDE_READY"));

    wait_until(|| fs::read_to_string(&lab.args_file).is_ok_and(|text| !text.is_empty()));
    let argv = fs::read_to_string(&lab.args_file).unwrap();
    let lines: Vec<&str> = argv.lines().collect();
    assert!(
        lines.contains(&"--model"),
        "fake argv lacks --model: {argv}"
    );
    assert!(lines.contains(&"test-x"), "fake argv lacks test-x: {argv}");

    let stopped = lab.cli(&["stop", "-n", "fake1"]);
    assert!(
        stopped.status.success(),
        "h1 stop -n fake1 failed: {}",
        combined(&stopped)
    );
    wait_until(|| !stdout(&lab.cli(&["list"])).contains("fake1"));
}

#[test]
fn help_lists_agent_commands() {
    let output = Command::new(binary())
        .arg("--help")
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "h1 --help failed: {}",
        combined(&output)
    );
    let text = combined(&output);
    for name in ["claude", "pi", "opencode", "codex", "adopt"] {
        assert!(
            text.lines().any(|line| line.trim_start().starts_with(name)),
            "top-level help does not list {name}:\n{text}"
        );
    }
}

#[test]
fn adopt_unknown_target() {
    let lab = Lab::new();
    let cases: [&[&str]; 2] = [
        &["adopt", "999999", "--detached"],
        &["attach", "--agent", "999999"],
    ];
    for args in cases {
        let output = lab.cli(args);
        assert!(
            !output.status.success(),
            "h1 {args:?} unexpectedly succeeded: {}",
            combined(&output)
        );
        let text = combined(&output).to_lowercase();
        assert!(
            [
                "no running agent",
                "no match",
                "matches no",
                "no agent",
                "not found",
            ]
            .iter()
            .any(|needle| text.contains(needle)),
            "h1 {args:?} should say that no running agent matches the target, got: {text}"
        );
    }
}

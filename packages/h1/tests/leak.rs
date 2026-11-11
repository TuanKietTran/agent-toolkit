//! Spec: no leaked sessions, sockets, processes or files after
//! `stop_all` (contract: `src/wire.rs`, feat/h1-signals @ b7a998e).
//!
//! Runs on disposable `cat` labs in a private `H1_DIR` and stops every
//! session it opened (the `Lab` drop is only a backstop). No gating:
//! if the `relation` subcommands are missing in this binary, the test
//! fails. Relations and signals are in-memory only, so after stop the
//! private `H1_DIR` must be completely empty.

use std::{
    fs,
    process::{Child, Command, Output, Stdio},
    thread,
    time::{Duration, Instant},
};

use serde_json::Value;

/// Generous: only reached when a test is failing.
const TIMEOUT: Duration = Duration::from_secs(60);

#[cfg(unix)]
mod os {
    /// A hosted program that stays alive until its host stops: plain `cat`.
    pub const IDLE: &[&str] = &["cat"];
}

#[cfg(windows)]
mod os {
    /// Windows stand-in for `cat`: swallow lines forever.
    pub const IDLE: &[&str] = &[
        "powershell",
        "-NoProfile",
        "-Command",
        "while (($l = [Console]::ReadLine()) -ne $null) {}",
    ];
}

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

/// An isolated session directory and the hosts started in it.
/// Everything is killed when dropped.
struct Lab {
    directory: tempfile::TempDir,
    hosts: Vec<Child>,
}

impl Lab {
    fn new() -> Self {
        Self {
            directory: tempfile::tempdir().unwrap(),
            hosts: Vec::new(),
        }
    }

    fn command(&self, args: &[&str]) -> Command {
        let mut command = Command::new(binary());
        command
            .env("H1_DIR", self.directory.path())
            .env_remove("H1_SOCKET")
            .env_remove("H1_NAME");
        command.args(args);
        command
    }

    fn cli(&self, args: &[&str]) -> Output {
        self.command(args).stdin(Stdio::null()).output().unwrap()
    }

    fn host(&mut self, name: &str, program: &[&str]) {
        let mut command = self.command(&["host", "--name", name, "--cols", "60", "--rows", "10"]);
        command
            .arg("--")
            .args(program)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        self.hosts.push(command.spawn().expect("host should start"));
        wait_until(|| self.cli(&["status", "-n", name]).status.success());
    }

    fn json(&self, args: &[&str]) -> Value {
        let output = self.cli(args);
        assert!(
            output.status.success(),
            "{args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        serde_json::from_slice(&output.stdout).unwrap_or_else(|error| {
            panic!(
                "{args:?}: {error}: {}",
                String::from_utf8_lossy(&output.stdout)
            )
        })
    }

    fn list_names(&self) -> Vec<String> {
        let listed = self.json(&["list", "--json"]);
        listed
            .as_array()
            .expect("list --json prints an array")
            .iter()
            .map(|entry| entry["name"].as_str().unwrap().to_owned())
            .collect()
    }

    /// Stop every named session (failures ignored) and wait until the
    /// private dir lists none: the always-stopped guarantee of these tests.
    fn stop_all(&self, names: &[&str]) {
        for name in names {
            let _ = self.cli(&["stop", "-n", name]);
        }
        wait_until(|| self.list_names().is_empty());
    }
}

impl Drop for Lab {
    fn drop(&mut self) {
        for host in &mut self.hosts {
            let _ = host.kill();
            let _ = host.wait();
        }
    }
}

#[test]
fn no_leaked_sessions_sockets_processes_or_files_after_stop_all() {
    let mut lab = Lab::new();
    lab.host("producer", os::IDLE);
    lab.host("consumer", os::IDLE);

    let added = lab.cli(&[
        "relation",
        "add",
        "producer",
        "parent",
        "consumer",
        "--cascade",
    ]);
    assert!(
        added.status.success(),
        "{}",
        String::from_utf8_lossy(&added.stderr)
    );

    // While running: both sessions are listed and both registry
    // files are present in the private H1_DIR.
    let mut names = lab.list_names();
    names.sort();
    assert_eq!(names, ["consumer", "producer"], "{names:?}");
    for name in ["producer", "consumer"] {
        assert!(
            lab.directory.path().join(format!("{name}.json")).exists(),
            "registry file for {name} present while running"
        );
    }

    lab.stop_all(&["producer", "consumer"]);

    // No sessions: list is empty and status no longer answers.
    assert!(lab.list_names().is_empty());
    assert!(!lab.cli(&["status", "-n", "producer"]).status.success());
    assert!(!lab.cli(&["status", "-n", "consumer"]).status.success());

    // No files: registry .json and socket .sock are both removed,
    // leaving the private H1_DIR completely empty (relations and
    // signals are in-memory only, so nothing else may appear).
    wait_until(|| {
        fs::read_dir(lab.directory.path())
            .map(|mut entries| entries.next().is_none())
            .unwrap_or(false)
    });

    // No processes: every host child has actually exited, not
    // just been forgotten by the registry.
    for host in &mut lab.hosts {
        wait_until(|| host.try_wait().unwrap().is_some());
    }
}

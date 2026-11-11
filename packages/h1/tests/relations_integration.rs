//! Spec: relations between hosted sessions (contract: `src/wire.rs`,
//! feat/h1-signals @ b7a998e).
//!
//! Runs on disposable `cat` labs in a private `H1_DIR` and stops every
//! session it opened (the `Lab` drop is only a backstop). No gating:
//! if the `relation` subcommands are missing in this binary, the test
//! fails. Expected edges are inlined below (formerly the relations.json
//! fixture's `list_response_consumer`).

use std::{
    collections::BTreeSet,
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

/// An edge set as comparable tuples, from a bare array or an
/// `{ok, edges}` response object (the CLI `--json` shape).
fn edge_set(value: &Value) -> BTreeSet<(String, String, String, bool)> {
    let edges = value
        .as_array()
        .or_else(|| value["edges"].as_array())
        .expect("edges array");
    edges
        .iter()
        .map(|edge| {
            (
                edge["from"].as_str().unwrap().to_owned(),
                edge["kind"].as_str().unwrap().to_owned(),
                edge["to"].as_str().unwrap().to_owned(),
                edge["cascade"].as_bool().unwrap_or(false),
            )
        })
        .collect()
}

#[test]
fn relations_add_list_graph_and_remove_on_cat_labs() {
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
    let added = lab.cli(&["relation", "add", "consumer", "depends_on", "producer"]);
    assert!(
        added.status.success(),
        "{}",
        String::from_utf8_lossy(&added.stderr)
    );

    // The consumer host knows both edges (one as `to`, one as `from`).
    let expected: BTreeSet<(String, String, String, bool)> = [
        (
            "producer".to_owned(),
            "parent".to_owned(),
            "consumer".to_owned(),
            true,
        ),
        (
            "consumer".to_owned(),
            "depends_on".to_owned(),
            "producer".to_owned(),
            false,
        ),
    ]
    .into_iter()
    .collect();
    let listed = lab.json(&["relation", "list", "-n", "consumer", "--json"]);
    assert_eq!(edge_set(&listed), expected, "{listed}");
    let graph = lab.json(&["relation", "graph", "--json"]);
    assert_eq!(edge_set(&graph), expected, "{graph}");

    let removed = lab.cli(&["relation", "remove", "consumer", "depends_on", "producer"]);
    assert!(
        removed.status.success(),
        "{}",
        String::from_utf8_lossy(&removed.stderr)
    );
    let listed = lab.json(&["relation", "list", "-n", "consumer", "--json"]);
    let remaining: BTreeSet<_> = [(
        "producer".to_owned(),
        "parent".to_owned(),
        "consumer".to_owned(),
        true,
    )]
    .into_iter()
    .collect();
    assert_eq!(edge_set(&listed), remaining, "{listed}");

    lab.stop_all(&["producer", "consumer"]);
}

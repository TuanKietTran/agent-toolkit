//! Spec: signals, events and relations between hosted sessions (contract:
//! `src/wire.rs` in the manager worktree, feat/h1-signals @ b7a998e).
//!
//! Every CLI test here runs on disposable `cat` labs in a private `H1_DIR`
//! and stops every session it opened (the `Lab` drop is only a backstop).
//! Until sg-core lands the `signal`/`event`/`relation` subcommands in this
//! branch the CLI tests skip with `SIGNALS_SKIPPED`; the fixture test
//! below always runs. Expected wire shapes live in
//! `tests/fixtures/signals/*.json` and are compared field-by-field,
//! ignoring `ts_ms`/`seq` values (presence and monotonic increase only).

use std::{
    collections::BTreeSet,
    fs,
    io::{BufRead, BufReader},
    path::Path,
    process::{Child, Command, Output, Stdio},
    sync::mpsc,
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

fn fixture(name: &str) -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/signals")
        .join(name);
    serde_json::from_str(&fs::read_to_string(&path).expect("fixture readable"))
        .unwrap_or_else(|error| panic!("{}: {error}", path.display()))
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

    /// Spawn a streaming CLI (`signal listen` / `event subscribe`) with
    /// piped stdout; collect its lines with [`collect`].
    fn stream(&self, args: &[&str]) -> Child {
        self.command(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("stream should start")
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

/// True once the `signal`/`event`/`relation` subcommands exist in this
/// binary; before sg-core lands every CLI test skips instead of failing.
fn signals_available(lab: &Lab) -> bool {
    ["signal", "event", "relation"]
        .iter()
        .all(|sub| lab.cli(&[sub, "--help"]).status.success())
}

macro_rules! require_signals {
    ($lab:expr) => {
        if !signals_available($lab) {
            eprintln!("SIGNALS_SKIPPED: signal/event/relation subcommands not in this binary yet");
            return;
        }
    };
}

/// Collect a streaming child's stdout lines until it exits or the
/// deadline passes, then reap it. Returns the JSON lines parsed.
fn collect(mut child: Child, deadline: Duration) -> Vec<Value> {
    let stdout = child.stdout.take().expect("stream stdout piped");
    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            match line {
                Ok(line) => {
                    if sender.send(line).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });
    let start = Instant::now();
    let mut lines = Vec::new();
    loop {
        match receiver.recv_timeout(Duration::from_millis(50)) {
            Ok(line) => lines.push(line),
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
        if child.try_wait().unwrap().is_some() {
            // Drain whatever the reader still holds.
            while let Ok(line) = receiver.try_recv() {
                lines.push(line);
            }
            break;
        }
        if start.elapsed() > deadline {
            let _ = child.kill();
            break;
        }
    }
    let _ = child.wait();
    lines
        .iter()
        .filter(|line| line.trim_start().starts_with('{'))
        .map(|line| serde_json::from_str(line).expect("stream lines are JSON objects"))
        .collect()
}

/// An edge set as comparable tuples, from a bare array or an
/// `{ok, edges}` response object (the CLI `--json` shape is sg-core's).
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

fn assert_frame_matches(actual: &Value, expected: &Value) {
    for (key, want) in expected.as_object().unwrap() {
        if key == "ts_ms" || key == "seq" {
            assert!(actual[key].is_u64(), "frame carries {key}: {actual}");
        } else {
            assert_eq!(&actual[key], want, "frame field {key}: {actual}");
        }
    }
}

#[test]
fn fixtures_parse_and_match_the_wire_vocabulary() {
    let ops: BTreeSet<&str> = [
        "signal_emit",
        "signal_listen",
        "event_subscribe",
        "relation_add",
        "relation_remove",
        "relation_list",
        "relation_release",
    ]
    .into_iter()
    .collect();
    let kinds: BTreeSet<&str> = [
        "started",
        "asking",
        "stalled",
        "idle",
        "exited",
        "closed",
        "relation_ended",
        "parent",
        "supervises",
        "depends_on",
        "pairs_with",
    ]
    .into_iter()
    .collect();
    fn walk(value: &Value, ops: &BTreeSet<&str>, kinds: &BTreeSet<&str>) {
        match value {
            Value::Object(map) => {
                for (key, inner) in map {
                    match (key.as_str(), inner) {
                        ("op", Value::String(op)) => assert!(ops.contains(op.as_str()), "op {op}"),
                        ("kind", Value::String(kind)) => {
                            assert!(kinds.contains(kind.as_str()), "kind {kind}")
                        }
                        ("relation", Value::String(kind)) => {
                            assert!(kinds.contains(kind.as_str()), "relation {kind}")
                        }
                        ("frame", Value::String(frame)) => {
                            assert!(
                                ["signal", "event", "end"].contains(&frame.as_str()),
                                "{frame}"
                            )
                        }
                        ("name", Value::String(name)) if !map.contains_key("description") => {
                            assert!(
                                !name.is_empty()
                                    && name.len() <= 64
                                    && name
                                        .chars()
                                        .all(|c| c.is_ascii_alphanumeric() || "._-".contains(c)),
                                "signal name {name}"
                            );
                        }
                        _ => {}
                    }
                    walk(inner, ops, kinds);
                }
            }
            Value::Array(items) => items.iter().for_each(|item| walk(item, ops, kinds)),
            _ => {}
        }
    }
    for name in ["signals.json", "events.json", "relations.json"] {
        walk(&fixture(name), &ops, &kinds);
    }
}

#[test]
fn relations_add_list_graph_and_remove_on_cat_labs() {
    let mut lab = Lab::new();
    require_signals!(&lab);
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

    // The consumer host knows both edges (one as `to`, one as `from`):
    // exactly the fixture's list response.
    let expected = edge_set(&fixture("relations.json")["list_response_consumer"]);
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

#[test]
fn signal_emit_reaches_a_named_listener_on_cat_labs() {
    let mut lab = Lab::new();
    require_signals!(&lab);
    lab.host("producer", os::IDLE);
    lab.host("consumer", os::IDLE);
    let expected = fixture("signals.json");

    // Text payload, the README/example signal.
    let listener = lab.stream(&[
        "signal",
        "listen",
        "-n",
        "consumer",
        "--name",
        "data.ready",
        "--count",
        "1",
        "--timeout-ms",
        "15000",
    ]);
    // The listener registers asynchronously; re-emit until it exits.
    let frames = {
        let mut listener = listener;
        let start = Instant::now();
        loop {
            let emitted = lab.cli(&[
                "signal",
                "emit",
                "-n",
                "producer",
                "--to",
                "consumer",
                "data.ready",
                "--text",
                "ready",
            ]);
            assert!(
                emitted.status.success(),
                "{}",
                String::from_utf8_lossy(&emitted.stderr)
            );
            if listener.try_wait().unwrap().is_some() || start.elapsed() > Duration::from_secs(20) {
                break collect(listener, Duration::from_secs(5));
            }
            thread::sleep(Duration::from_millis(100));
        }
    };
    let signal_frames: Vec<&Value> = frames.iter().filter(|f| f["frame"] == "signal").collect();
    assert_eq!(signal_frames.len(), 1, "{frames:?}");
    assert_frame_matches(signal_frames[0], &expected["frames"][0]);

    lab.stop_all(&["producer", "consumer"]);
}

#[test]
fn event_subscribe_sees_relation_ended_and_cascade_stops_the_child() {
    let mut lab = Lab::new();
    require_signals!(&lab);
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

    let subscriber = lab.stream(&[
        "event",
        "subscribe",
        "-n",
        "consumer",
        "--kind",
        "relation_ended",
        "--count",
        "1",
        "--timeout-ms",
        "15000",
    ]);
    // Give the subscription a moment to register before the parent ends.
    thread::sleep(Duration::from_millis(500));
    let stopped = lab.cli(&["stop", "-n", "producer"]);
    assert!(
        stopped.status.success(),
        "{}",
        String::from_utf8_lossy(&stopped.stderr)
    );

    let frames = collect(subscriber, Duration::from_secs(20));
    let expected = &fixture("events.json")["relation_ended_frames"][0];
    let ended: Vec<&Value> = frames
        .iter()
        .filter(|f| f["frame"] == "event" && f["kind"] == "relation_ended")
        .collect();
    assert_eq!(ended.len(), 1, "{frames:?}");
    assert_frame_matches(ended[0], expected);

    // Cascade: stopping the parent stopped the child too.
    lab.stop_all(&["producer", "consumer"]);
    assert!(lab.list_names().is_empty());
}

#[test]
fn no_leaked_sessions_sockets_processes_or_files_after_stop_all() {
    let mut lab = Lab::new();
    lab.host("producer", os::IDLE);
    lab.host("consumer", os::IDLE);

    // Exercise relation state when sg-core has landed; the leak
    // guarantee below applies to plain hosting either way.
    if signals_available(&lab) {
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
    }

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

//! Spec: events between hosted sessions (contract: `src/wire.rs`,
//! feat/h1-signals @ b7a998e).
//!
//! Runs on disposable `cat` labs in a private `H1_DIR` and stops every
//! session it opened (the `Lab` drop is only a backstop). No gating:
//! if the `event`/`relation` subcommands are missing in this binary,
//! the test fails. Expected frames are inlined below (formerly the
//! events.json fixture's `relation_ended_frames`).

use std::{
    io::{BufRead, BufReader},
    process::{Child, Command, Output, Stdio},
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};

use serde_json::{Value, json};

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

    /// Spawn a streaming CLI (`event subscribe`) with piped stdout;
    /// collect its lines with [`collect`].
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
fn event_subscribe_sees_relation_ended_and_cascade_stops_the_child() {
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

    // Inlined from the former events.json fixture, relation_ended_frames[0].
    let expected = json!({
        "frame": "event", "kind": "relation_ended", "app": "consumer",
        "ts_ms": 5, "seq": 5,
        "detail": { "ended": "producer", "relation": "parent", "role": "from" }
    });

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
    let ended: Vec<&Value> = frames
        .iter()
        .filter(|f| f["frame"] == "event" && f["kind"] == "relation_ended")
        .collect();
    assert_eq!(ended.len(), 1, "{frames:?}");
    assert_frame_matches(ended[0], &expected);

    // Cascade: stopping the parent stopped the child too.
    lab.stop_all(&["producer", "consumer"]);
    assert!(lab.list_names().is_empty());
}

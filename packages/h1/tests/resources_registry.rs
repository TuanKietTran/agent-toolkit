//! Integration test for the resource registry CLI (`alloc` / `resources` / `release` / `gc`).

use std::fs;
use std::path::Path;
use std::process::Command;
use std::time::{Duration, Instant};

fn h1(dir: &Path, args: &[&str]) -> (String, bool) {
    let output = Command::new(env!("CARGO_BIN_EXE_h1"))
        .args(args)
        .env("H1_DIR", dir)
        .env_remove("H1_SOCKET")
        .env_remove("H1_NAME")
        .output()
        .expect("run h1");
    (
        String::from_utf8_lossy(&output.stdout).into_owned(),
        output.status.success(),
    )
}

/// Kills the wrapped child on drop, so a failed assertion never leaks the sleeper.
#[cfg(unix)]
struct KillOnDrop(std::process::Child);

#[cfg(unix)]
impl Drop for KillOnDrop {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[cfg(unix)]
fn process_alive(pid: u32) -> bool {
    Command::new("kill")
        .args(["-0", &pid.to_string()])
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

#[cfg(unix)]
#[test]
fn alloc_each_kind_then_gc_leaves_nothing() {
    let h1_dir = tempfile::tempdir().expect("h1 dir");
    let base = tempfile::tempdir().expect("base dir");
    let wt = base.path().join("wt");
    let clone = base.path().join("clone");
    let tmpd = base.path().join("tmpd");
    for dir in [&wt, &clone, &tmpd] {
        fs::create_dir(dir).expect("create resource dir");
    }

    let mut sleeper = KillOnDrop(
        Command::new("sleep")
            .arg("60")
            .spawn()
            .expect("spawn sleep"),
    );
    let pid = sleeper.0.id().to_string();

    let wt_value = wt.to_str().expect("wt path is utf-8");
    let clone_value = clone.to_str().expect("clone path is utf-8");
    let tmpd_value = tmpd.to_str().expect("tmp path is utf-8");
    for (kind, value) in [
        ("worktree", wt_value),
        ("clone", clone_value),
        ("tmp", tmpd_value),
        ("port", "45991"),
        ("proc", pid.as_str()),
    ] {
        let (out, ok) = h1(h1_dir.path(), &["alloc", kind, value, "--run", "run1"]);
        assert!(ok, "alloc {kind} {value} failed: {out}");
    }

    let (out, ok) = h1(h1_dir.path(), &["resources", "--run", "run1"]);
    assert!(ok, "resources --run run1 failed: {out}");
    for value in [wt_value, clone_value, tmpd_value, "45991", pid.as_str()] {
        assert!(out.contains(value), "resources missing {value}: {out}");
    }

    let (out, ok) = h1(h1_dir.path(), &["gc", "--run", "run1"]);
    assert!(ok, "gc --run run1 failed: {out}");
    assert!(!wt.exists(), "worktree dir still exists after gc");
    assert!(!clone.exists(), "clone dir still exists after gc");
    assert!(!tmpd.exists(), "tmp dir still exists after gc");

    // The recorded proc must be dead. Reap it through the child handle while polling:
    // a zombie still answers `kill -0` until it is waited on.
    let pid_num: u32 = pid.parse().expect("pid is numeric");
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        if let Ok(Some(_)) = sleeper.0.try_wait() {
            break;
        }
        if !process_alive(pid_num) {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "sleep process {pid} still alive after gc"
        );
        std::thread::sleep(Duration::from_millis(50));
    }

    let (out, ok) = h1(h1_dir.path(), &["resources"]);
    assert!(ok, "resources failed: {out}");
    assert!(
        out.contains("no resources"),
        "expected no resources, got: {out}"
    );

    let store = h1_dir.path().join("resources.json");
    if store.exists() {
        let text = fs::read_to_string(&store).expect("read resources.json");
        assert!(
            !text.contains("run1"),
            "resources.json still records run1: {text}"
        );
    }
}

#[test]
fn release_only_frees_named_run() {
    let h1_dir = tempfile::tempdir().expect("h1 dir");
    let base = tempfile::tempdir().expect("base dir");
    let dir1 = base.path().join("one");
    let dir2 = base.path().join("two");
    fs::create_dir(&dir1).expect("create run1 dir");
    fs::create_dir(&dir2).expect("create run2 dir");
    let value1 = dir1.to_str().expect("run1 path is utf-8");
    let value2 = dir2.to_str().expect("run2 path is utf-8");

    for (value, run) in [(value1, "run1"), (value2, "run2")] {
        let (out, ok) = h1(h1_dir.path(), &["alloc", "tmp", value, "--run", run]);
        assert!(ok, "alloc tmp {value} --run {run} failed: {out}");
    }

    let (out, ok) = h1(h1_dir.path(), &["release", "--run", "run1"]);
    assert!(ok, "release --run run1 failed: {out}");
    assert!(!dir1.exists(), "run1 dir still exists after release");
    assert!(dir2.exists(), "run2 dir must survive release of run1");

    let (out, ok) = h1(h1_dir.path(), &["resources", "--run", "run2"]);
    assert!(ok, "resources --run run2 failed: {out}");
    assert!(
        out.contains(value2),
        "run2 record missing after release of run1: {out}"
    );

    let (out, ok) = h1(h1_dir.path(), &["gc", "--run", "run2"]);
    assert!(ok, "gc --run run2 failed: {out}");
    assert!(!dir2.exists(), "run2 dir still exists after gc");
}

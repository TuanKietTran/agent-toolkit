//! A `h1` program that was written an instant ago can be "busy" (ETXTBSY) while some other
//! handle still has it open for writing. That is transient: `ProcessRunner` must wait it out
//! through the same retry the vault provider path uses, instead of reporting the run failed.

#![cfg(unix)]

use h1::yah::cli::{LabRunner, ProcessRunner};
use std::collections::HashSet;
use std::fs;
use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::time::Duration;

/// Write `script` as an executable `h1` in a fresh temp dir, leaving the writer handle OPEN:
/// exec of the file fails with ETXTBSY until the returned handle is dropped.
fn busy_script(script: &str) -> (tempfile::TempDir, PathBuf, fs::File) {
    let dir = tempfile::tempdir().unwrap();
    let prog = dir.path().join("h1");
    let mut writer = fs::File::create(&prog).unwrap();
    writer.write_all(script.as_bytes()).unwrap();
    writer.flush().unwrap();
    fs::set_permissions(&prog, fs::Permissions::from_mode(0o755)).unwrap();
    (dir, prog, writer)
}

fn release_after(writer: fs::File) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(200));
        drop(writer);
    })
}

#[test]
fn a_busy_h1_is_retried_for_list_names() {
    let (_dir, prog, writer) = busy_script("#!/bin/sh\necho '[\"ready\"]'\n");
    let release = release_after(writer);
    let runner = ProcessRunner { bin: prog };
    let names = runner.list_names();
    release.join().unwrap();
    let expected: HashSet<String> = HashSet::from(["ready".to_string()]);
    assert_eq!(
        names.as_ref(),
        Ok(&expected),
        "a busy h1 must be retried: {names:?}"
    );
}

#[test]
fn a_busy_h1_is_retried_for_open() {
    let (dir, prog, writer) = busy_script("#!/bin/sh\nexit 0\n");
    let release = release_after(writer);
    let runner = ProcessRunner { bin: prog };
    let out = runner.open(&["open".to_string()], &[], &dir.path().join("open.log"));
    release.join().unwrap();
    assert_eq!(
        out.as_ref().map(|_| ()),
        Ok(()),
        "a busy h1 must be retried: {out:?}"
    );
}

#[test]
fn a_missing_h1_still_fails_at_once() {
    let started = std::time::Instant::now();
    let runner = ProcessRunner {
        bin: PathBuf::from("/nonexistent/h1-binary"),
    };
    let err = runner.list_names().unwrap_err();
    assert!(err.starts_with("run /nonexistent/h1-binary"), "{err}");
    assert!(
        started.elapsed() < Duration::from_millis(500),
        "a missing program must not be retried: {:?}",
        started.elapsed()
    );
}

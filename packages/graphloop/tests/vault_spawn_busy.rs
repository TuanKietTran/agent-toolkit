//! A vault provider program that was written an instant ago can be "busy" (ETXTBSY) while some other
//! handle still has it open for writing. That is transient: the fetch must wait it out instead of
//! reporting the provider as not installed.

#![cfg(unix)]

use graphloop::vault::run_command;
use std::fs;
use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use std::time::Duration;

#[test]
fn a_program_still_open_for_writing_is_retried_not_reported_as_missing() {
    let dir = tempfile::tempdir().unwrap();
    let prog = dir.path().join("provider");
    let mut writer = fs::File::create(&prog).unwrap();
    writer.write_all(b"#!/bin/sh\necho ready\n").unwrap();
    writer.flush().unwrap();
    fs::set_permissions(&prog, fs::Permissions::from_mode(0o755)).unwrap();
    // `writer` stays open: exec of this file fails with ETXTBSY until it is dropped.
    let release = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(200));
        drop(writer);
    });
    let out = run_command(&[prog.to_string_lossy().into_owned()], &[], Duration::from_secs(5));
    release.join().unwrap();
    assert_eq!(out.as_deref(), Ok("ready"), "a busy program file must be retried: {out:?}");
}

#[test]
fn a_missing_program_still_fails_at_once() {
    let started = std::time::Instant::now();
    let err = run_command(&["/nonexistent/provider-binary".to_owned()], &[], Duration::from_secs(5)).unwrap_err();
    assert!(err.starts_with("could not run provider-binary"), "{err}");
    assert!(started.elapsed() < Duration::from_millis(500), "a missing program must not be retried: {:?}", started.elapsed());
}

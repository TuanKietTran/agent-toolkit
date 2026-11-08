//! Hardening tests for `vault.rs` (V4): BOM/CRLF/duplicate keys in dotenv files, huge or
//! non-UTF8 command/provider output, timeouts killing the whole process group (no orphan
//! children), and scrubbing of overlapping secrets (longest first).

use std::fs;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
#[cfg(unix)]
use std::process::{Command, Stdio};
#[cfg(unix)]
use std::time::{Duration, Instant};

use graphloop::spec::Vault;
use graphloop::vault::{parse_dotenv, scrub, Vaults};

fn vault(provider: &str) -> Vault {
    Vault { name: "v".into(), provider: provider.into(), path: None, account: None, command: Vec::new(), secrets: Vec::new(), line: 1 }
}

fn fetch(v: Vault, key: &str) -> Result<String, String> {
    let vs = [v];
    let env = |_: &str| -> Option<String> { None };
    Vaults::new(&vs, PathBuf::from("."), &env).get("v", key)
}

#[cfg(unix)]
fn fetch_timeout(v: Vault, key: &str, timeout: Duration) -> Result<String, String> {
    let vs = [v];
    let env = |_: &str| -> Option<String> { None };
    Vaults::new(&vs, PathBuf::from("."), &env).with_timeout(timeout).get("v", key)
}

#[cfg(unix)]
fn write_script(dir: &Path, name: &str, body: &str) -> PathBuf {
    let p = dir.join(name);
    fs::write(&p, format!("#!/bin/sh\n{body}\n")).unwrap();
    fs::set_permissions(&p, fs::Permissions::from_mode(0o755)).unwrap();
    p
}

#[test]
fn dotenv_bom_is_stripped_and_first_key_survives() {
    let m = parse_dotenv("\u{feff}TOKEN=abc\nOTHER=two\n");
    assert_eq!(m["TOKEN"], "abc");
    assert_eq!(m["OTHER"], "two");
}

#[test]
fn dotenv_crlf_values_have_no_carriage_return() {
    let m = parse_dotenv("A=one\r\nB=two\r\n");
    assert_eq!(m["A"], "one");
    assert_eq!(m["B"], "two");
}

#[test]
fn dotenv_duplicate_keys_last_wins() {
    let m = parse_dotenv("K=first\nK=second\nK=third\n");
    assert_eq!(m["K"], "third");
}

#[test]
fn dotenv_file_with_bom_and_crlf_reads_through_the_vault() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("fleet.env");
    let mut bytes = vec![0xEF, 0xBB, 0xBF];
    bytes.extend_from_slice(b"FLEET_TOKEN=s3cret\r\nOTHER=x\r\n");
    fs::write(&path, bytes).unwrap();
    let mut v = vault("dotenv");
    v.path = Some(path.to_string_lossy().into_owned());
    assert_eq!(fetch(v, "FLEET_TOKEN").unwrap(), "s3cret");
}

#[cfg(unix)]
#[test]
fn command_non_utf8_output_is_an_error() {
    let dir = tempfile::tempdir().unwrap();
    let bytes = dir.path().join("raw.out");
    fs::write(&bytes, [0xFF, 0xFE, 0x41, 0x42]).unwrap();
    let script = write_script(dir.path(), "raw", &format!("cat {}", bytes.display()));
    let mut v = vault("command");
    v.command = vec![script.to_string_lossy().into_owned()];
    let err = fetch(v, "K").unwrap_err();
    assert!(err.contains("not UTF-8"), "{err}");
}

#[cfg(unix)]
#[test]
fn command_huge_output_is_rejected() {
    let mut v = vault("command");
    v.command = vec!["sh".into(), "-c".into(), "head -c 2097152 /dev/zero | tr '\\0' 'a'".into()];
    let err = fetch(v, "K").unwrap_err();
    assert!(err.contains("more than") && err.contains("bytes of output"), "{err}");
}

#[cfg(unix)]
#[test]
fn provider_huge_output_is_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let script = write_script(dir.path(), "op", "head -c 2097152 /dev/zero | tr '\\0' 'a'");
    let mut v = vault("1password");
    v.command = vec![script.to_string_lossy().into_owned()];
    let err = fetch(v, "op://vault/item/field").unwrap_err();
    assert!(err.contains("more than") && err.contains("bytes of output"), "{err}");
}

#[cfg(unix)]
#[test]
fn timeout_kills_the_whole_process_group() {
    let dir = tempfile::tempdir().unwrap();
    let pid_file = dir.path().join("child.pid");
    let mut v = vault("command");
    v.command = vec!["sh".into(), "-c".into(), format!("sleep 300 & echo $! > {}; wait", pid_file.display())];
    let err = fetch_timeout(v, "K", Duration::from_millis(300)).unwrap_err();
    assert!(err.contains("did not finish"), "{err}");
    let mut pid = None;
    let deadline = Instant::now() + Duration::from_secs(2);
    while Instant::now() < deadline {
        if let Ok(text) = fs::read_to_string(&pid_file)
            && let Ok(n) = text.trim().parse::<u32>() { pid = Some(n); break; }
        std::thread::sleep(Duration::from_millis(50));
    }
    let pid = pid.expect("the child shell wrote its background pid");
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        let alive = Command::new("kill").args(["-0", &pid.to_string()]).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).status().map(|s| s.success()).unwrap_or(false);
        if !alive { break; }
        assert!(Instant::now() < deadline, "grandchild sleep {pid} survived the timeout kill");
        std::thread::sleep(Duration::from_millis(100));
    }
}

#[test]
fn scrub_overlapping_secrets_longest_first_regardless_of_order() {
    let short_first = vec!["abc".to_owned(), "abcdef".to_owned()];
    let long_first = vec!["abcdef".to_owned(), "abc".to_owned()];
    for secrets in [short_first, long_first] {
        assert_eq!(scrub("k=abcdef j=abc", &secrets), "k=*** j=***");
        assert_eq!(scrub("abcdef", &secrets), "***");
    }
}

#[test]
fn scrub_overlapping_prefix_leaves_nothing_exposed() {
    let secrets = vec!["bc".to_owned(), "abcd".to_owned()];
    assert_eq!(scrub("abcd", &secrets), "***");
}

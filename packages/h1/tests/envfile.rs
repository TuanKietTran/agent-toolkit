//! Integration tests for `--env-file` loading (`graphloop::envfile::EnvFiles`).
//!
//! Priority contract: the real process environment wins over every file; among files an
//! earlier `--env-file` wins over a later one, and every explicit file wins over the
//! implicit `.env` beside the `.yah` file. Values are never printed by the loader.

use std::path::{Path, PathBuf};

use graphloop::envfile::EnvFiles;

fn write(dir: &Path, name: &str, text: &str) -> PathBuf {
    let path = dir.join(name);
    std::fs::write(&path, text).unwrap();
    path
}

fn no_real(_: &str) -> Option<String> { None }

#[test]
fn earlier_explicit_file_wins_over_later_and_implicit() {
    let dir = tempfile::tempdir().unwrap();
    let yah = write(dir.path(), "fleet.yah", "yah 1\n");
    write(dir.path(), ".env", "SHARED=implicit\nIMPLICIT_ONLY=1\n");
    let first = write(dir.path(), "a.env", "SHARED=first\nFIRST_ONLY=1\n");
    let second = write(dir.path(), "b.env", "SHARED=second\nSECOND_ONLY=1\n");
    let files = EnvFiles::load(&yah, &[first, second], true).unwrap();
    assert_eq!(files.get("SHARED").as_deref(), Some("first"));
    assert_eq!(files.get("FIRST_ONLY").as_deref(), Some("1"));
    assert_eq!(files.get("SECOND_ONLY").as_deref(), Some("1"));
    assert_eq!(files.get("IMPLICIT_ONLY").as_deref(), Some("1"));
}

#[test]
fn implicit_env_beside_the_yah_is_loaded_and_can_be_disabled() {
    let dir = tempfile::tempdir().unwrap();
    let yah = write(dir.path(), "fleet.yah", "yah 1\n");
    write(dir.path(), ".env", "TOKEN=from-implicit\n");
    let files = EnvFiles::load(&yah, &[], true).unwrap();
    assert_eq!(files.get("TOKEN").as_deref(), Some("from-implicit"));
    let files = EnvFiles::load(&yah, &[], false).unwrap();
    assert!(files.is_empty());
    assert_eq!(files.get("TOKEN"), None);
}

#[test]
fn missing_implicit_env_is_not_an_error_but_missing_explicit_is() {
    let dir = tempfile::tempdir().unwrap();
    let yah = write(dir.path(), "fleet.yah", "yah 1\n");
    let files = EnvFiles::load(&yah, &[], true).unwrap();
    assert!(files.is_empty());
    let err = EnvFiles::load(&yah, &[dir.path().join("nope.env")], true).unwrap_err();
    assert!(err.contains("cannot read env file"), "{err}");
    assert!(err.contains("nope.env"), "{err}");
}

#[test]
fn lookup_prefers_the_real_environment_then_the_files() {
    let files = EnvFiles::from_entries(vec![("A".into(), "file-a".into()), ("B".into(), "file-b".into())]);
    let real = |name: &str| -> Option<String> { if name == "A" { Some("real-a".into()) } else { None } };
    assert_eq!(files.lookup("A", &real).as_deref(), Some("real-a"));
    assert_eq!(files.lookup("B", &real).as_deref(), Some("file-b"));
    assert_eq!(files.lookup("C", &real), None);
    assert_eq!(files.lookup("B", &no_real).as_deref(), Some("file-b"));
}

#[test]
fn from_entries_is_first_wins_and_command_env_is_sorted() {
    let files = EnvFiles::from_entries(vec![("ZED".into(), "z".into()), ("ALPHA".into(), "a".into()), ("ZED".into(), "z2".into())]);
    assert_eq!(files.len(), 2);
    assert_eq!(files.get("ZED").as_deref(), Some("z"));
    assert_eq!(files.command_env(), vec![("ALPHA".to_string(), "a".to_string()), ("ZED".to_string(), "z".to_string())]);
}

// --- H11: real-world env-file edges. Each case loads through `EnvFiles::load` (the
// `--env-file` path) with a fixed fake value, asserted here only — never printed.

#[test]
fn crlf_line_endings_leave_no_carriage_return_in_values() {
    let dir = tempfile::tempdir().unwrap();
    let yah = write(dir.path(), "fleet.yah", "yah 1\n");
    let env = write(dir.path(), "crlf.env", "ALPHA=one\r\nBETA=two words\r\n");
    let files = EnvFiles::load(&yah, &[env], false).unwrap();
    assert_eq!(files.get("ALPHA").as_deref(), Some("one"));
    assert_eq!(files.get("BETA").as_deref(), Some("two words"));
    assert!(files.command_env().iter().all(|(_, v)| !v.contains('\r')));
}

#[test]
fn utf8_bom_at_file_start_first_key_parses_cleanly() {
    let dir = tempfile::tempdir().unwrap();
    let yah = write(dir.path(), "fleet.yah", "yah 1\n");
    let env = write(dir.path(), "bom.env", "\u{feff}TOKEN=abc\nOTHER=two\n");
    let files = EnvFiles::load(&yah, &[env], false).unwrap();
    assert_eq!(files.len(), 2);
    assert_eq!(files.get("TOKEN").as_deref(), Some("abc"));
    assert_eq!(files.get("OTHER").as_deref(), Some("two"));
}

#[test]
fn duplicate_keys_last_occurrence_wins() {
    use graphloop::spec::Vault;
    use graphloop::vault::Vaults;
    let dir = tempfile::tempdir().unwrap();
    let yah = write(dir.path(), "fleet.yah", "yah 1\n");
    let env = write(dir.path(), "dup.env", "DUP=first\nDUP=second\nDUP=third\n");
    let files = EnvFiles::load(&yah, std::slice::from_ref(&env), false).unwrap();
    // Effective value at the env-file layer: one entry, the last occurrence.
    assert_eq!(files.len(), 1);
    assert_eq!(files.get("DUP").as_deref(), Some("third"));
    assert_eq!(files.lookup("DUP", &no_real).as_deref(), Some("third"));
    assert_eq!(files.command_env(), vec![("DUP".to_string(), "third".to_string())]);
    // Fetch-path assertion: the same file read as a dotenv vault returns the last value.
    let v = Vault { name: "v".into(), provider: "dotenv".into(), path: Some(env.to_string_lossy().into_owned()), account: None, command: Vec::new(), secrets: Vec::new(), line: 1 };
    let vs = [v];
    let no_env = |_: &str| -> Option<String> { None };
    assert_eq!(Vaults::new(&vs, PathBuf::from("."), &no_env).get("v", "DUP").unwrap(), "third");
}

#[test]
fn value_containing_equals_signs_is_kept_intact() {
    let dir = tempfile::tempdir().unwrap();
    let yah = write(dir.path(), "fleet.yah", "yah 1\n");
    let env = write(dir.path(), "eq.env", "TOKEN=abc=def==\nOTHER=plain\n");
    let files = EnvFiles::load(&yah, &[env], false).unwrap();
    assert_eq!(files.get("TOKEN").as_deref(), Some("abc=def=="));
    assert_eq!(files.get("OTHER").as_deref(), Some("plain"));
}

#[test]
fn empty_value_is_present_and_empty_not_missing() {
    let dir = tempfile::tempdir().unwrap();
    let yah = write(dir.path(), "fleet.yah", "yah 1\n");
    let env = write(dir.path(), "empty.env", "EMPTY=\nSET=x\n");
    let files = EnvFiles::load(&yah, &[env], false).unwrap();
    assert_eq!(files.get("EMPTY").as_deref(), Some(""));
    assert_eq!(files.lookup("EMPTY", &no_real).as_deref(), Some(""));
    assert!(files.command_env().contains(&("EMPTY".to_string(), String::new())));
    assert_eq!(files.get("SET").as_deref(), Some("x"));
    assert_eq!(files.get("MISSING"), None);
}

#[test]
fn final_line_without_trailing_newline_is_parsed() {
    let dir = tempfile::tempdir().unwrap();
    let yah = write(dir.path(), "fleet.yah", "yah 1\n");
    let env = write(dir.path(), "nonl.env", "FIRST=1\nLAST=2");
    let files = EnvFiles::load(&yah, &[env], false).unwrap();
    assert_eq!(files.len(), 2);
    assert_eq!(files.get("FIRST").as_deref(), Some("1"));
    assert_eq!(files.get("LAST").as_deref(), Some("2"));
}

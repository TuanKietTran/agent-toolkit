//! Integration tests for the CLI vault providers (1password, bitwarden, bitwarden-secrets,
//! keychain). No real programs are needed: each test writes a fake CLI shell script into a temp
//! dir, points the vault's `command` override at it, and asserts the exact argv the fake
//! received (logged one arg per line), that failures never leak a value, and that a missing
//! program yields the install hint.

#![cfg(unix)]

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use h1::yah::spec::Vault;
use h1::yah::vault::Vaults;

const VALUE: &str = "fake-secret-value-123";

struct Fake {
    bin: PathBuf,
    log: PathBuf,
}

fn fake(dir: &Path, name: &str, stdout: &str, stderr: &str, code: i32) -> Fake {
    let log = dir.join(format!("{name}.argv.log"));
    let out_file = dir.join(format!("{name}.stdout"));
    let err_file = dir.join(format!("{name}.stderr"));
    fs::write(&out_file, stdout).unwrap();
    fs::write(&err_file, stderr).unwrap();
    let bin = dir.join(name);
    let script = format!(
        "#!/bin/sh\nfor a in \"$@\"; do printf '%s\\n' \"$a\" >> \"{}\"; done\ncat \"{}\"\ncat \"{}\" >&2\nexit {code}\n",
        log.display(),
        out_file.display(),
        err_file.display()
    );
    fs::write(&bin, script).unwrap();
    fs::set_permissions(&bin, fs::Permissions::from_mode(0o755)).unwrap();
    Fake { bin, log }
}

fn argv(fake: &Fake) -> Vec<String> {
    fs::read_to_string(&fake.log)
        .unwrap()
        .lines()
        .map(str::to_owned)
        .collect()
}

fn vault(provider: &str, bin: &Path) -> Vault {
    Vault {
        name: "v".into(),
        provider: provider.into(),
        path: None,
        account: None,
        command: vec![bin.to_string_lossy().into_owned()],
        plugin: None,
        options: Vec::new(),
        secrets: Vec::new(),
        line: 1,
    }
}

fn fetch(v: Vault, key: &str) -> Result<String, String> {
    let vs = [v];
    let env = |_: &str| -> Option<String> { None };
    Vaults::new(&vs, PathBuf::from("."), &env).get("v", key)
}

fn missing(provider: &str, prog: &str) -> String {
    let mut v = vault(provider, Path::new("/nonexistent"));
    v.command = vec![format!("/nonexistent/{prog}")];
    fetch(v, "some-ref").unwrap_err()
}

#[test]
fn op_read_with_account_exact_argv() {
    let dir = tempfile::tempdir().unwrap();
    let f = fake(dir.path(), "op", VALUE, "", 0);
    let mut v = vault("1password", &f.bin);
    v.account = Some("x.1password.com".into());
    v.secrets = vec![("API".into(), "op://vault/item/field".into())];
    assert_eq!(fetch(v, "API").unwrap(), VALUE);
    assert_eq!(
        argv(&f),
        vec![
            "read",
            "op://vault/item/field",
            "--account",
            "x.1password.com"
        ]
    );
}

#[test]
fn op_read_without_account_uses_key_as_ref() {
    let dir = tempfile::tempdir().unwrap();
    let f = fake(dir.path(), "op", VALUE, "", 0);
    let v = vault("1password", &f.bin);
    assert_eq!(fetch(v, "op://vault/item/field").unwrap(), VALUE);
    assert_eq!(argv(&f), vec!["read", "op://vault/item/field"]);
}

#[test]
fn op_missing_program_install_hint() {
    let err = missing("1password", "op");
    assert!(err.contains("op") && err.contains("install"), "{err}");
    assert!(!err.contains(VALUE), "{err}");
}

#[test]
fn op_failure_error_has_no_value() {
    let dir = tempfile::tempdir().unwrap();
    let f = fake(dir.path(), "op", VALUE, "item not found", 1);
    let v = vault("1password", &f.bin);
    let err = fetch(v, "op://vault/item/field").unwrap_err();
    // Provider stderr is never quoted (H2: it can echo the secret being fetched), so
    // "item not found" no longer appears; the error names the program + exit status only.
    assert!(err.contains("op") && err.contains("exited"), "{err}");
    assert!(!err.contains("item not found"), "{err}");
    assert!(!err.contains(VALUE), "{err}");
}

#[test]
fn bw_bare_item_gets_password() {
    let dir = tempfile::tempdir().unwrap();
    let f = fake(dir.path(), "bw", VALUE, "", 0);
    let mut v = vault("bitwarden", &f.bin);
    v.secrets = vec![("K".into(), "myitem".into())];
    assert_eq!(fetch(v, "K").unwrap(), VALUE);
    assert_eq!(
        argv(&f),
        vec!["get", "password", "myitem", "--nointeraction", "--raw"]
    );
}

#[test]
fn bw_username_suffix() {
    let dir = tempfile::tempdir().unwrap();
    let f = fake(dir.path(), "bw", VALUE, "", 0);
    let v = vault("bitwarden", &f.bin);
    assert_eq!(fetch(v, "myitem/username").unwrap(), VALUE);
    assert_eq!(
        argv(&f),
        vec!["get", "username", "myitem", "--nointeraction", "--raw"]
    );
}

#[test]
fn bw_totp_suffix() {
    let dir = tempfile::tempdir().unwrap();
    let f = fake(dir.path(), "bw", VALUE, "", 0);
    let v = vault("bitwarden", &f.bin);
    assert_eq!(fetch(v, "myitem/totp").unwrap(), VALUE);
    assert_eq!(
        argv(&f),
        vec!["get", "totp", "myitem", "--nointeraction", "--raw"]
    );
}

#[test]
fn bw_uri_suffix() {
    let dir = tempfile::tempdir().unwrap();
    let f = fake(dir.path(), "bw", VALUE, "", 0);
    let v = vault("bitwarden", &f.bin);
    assert_eq!(fetch(v, "myitem/uri").unwrap(), VALUE);
    assert_eq!(
        argv(&f),
        vec!["get", "uri", "myitem", "--nointeraction", "--raw"]
    );
}

#[test]
fn bw_custom_field_json_parsing() {
    let dir = tempfile::tempdir().unwrap();
    let json = "{\"id\":\"1\",\"name\":\"myitem\",\"fields\":[{\"name\":\"api_key\",\"value\":\"field-secret-123\",\"type\":0},{\"name\":\"other\",\"value\":\"zzz\",\"type\":0}]}";
    let f = fake(dir.path(), "bw", json, "", 0);
    let v = vault("bitwarden", &f.bin);
    assert_eq!(fetch(v, "myitem#api_key").unwrap(), "field-secret-123");
    assert_eq!(
        argv(&f),
        vec!["get", "item", "myitem", "--nointeraction", "--raw"]
    );
}

#[test]
fn bw_custom_field_missing_errors_without_values() {
    let dir = tempfile::tempdir().unwrap();
    let json = "{\"id\":\"1\",\"name\":\"myitem\",\"fields\":[{\"name\":\"api_key\",\"value\":\"field-secret-123\",\"type\":0}]}";
    let f = fake(dir.path(), "bw", json, "", 0);
    let v = vault("bitwarden", &f.bin);
    let err = fetch(v, "myitem#nope").unwrap_err();
    assert!(err.contains("nope"), "{err}");
    assert!(!err.contains("field-secret-123"), "{err}");
}

#[test]
fn bw_locked_error_says_bw_unlock() {
    let dir = tempfile::tempdir().unwrap();
    let f = fake(dir.path(), "bw", "", "Vault is locked.", 1);
    let v = vault("bitwarden", &f.bin);
    let err = fetch(v, "myitem").unwrap_err();
    assert!(err.contains("bw unlock"), "{err}");
    assert!(!err.contains(VALUE), "{err}");
}

#[test]
fn bw_missing_program_install_hint() {
    let err = missing("bitwarden", "bw");
    assert!(err.contains("bw") && err.contains("install"), "{err}");
}

#[test]
fn bws_secret_get_parses_value_field() {
    let dir = tempfile::tempdir().unwrap();
    let json = "{\"id\":\"abc\",\"key\":\"K\",\"value\":\"bws-secret-9\",\"projectId\":\"p\"}";
    let f = fake(dir.path(), "bws", json, "", 0);
    let v = vault("bitwarden-secrets", &f.bin);
    assert_eq!(fetch(v, "secret-id-123").unwrap(), "bws-secret-9");
    assert_eq!(
        argv(&f),
        vec!["secret", "get", "secret-id-123", "--output", "json"]
    );
}

#[test]
fn bws_missing_value_field_is_an_error() {
    let dir = tempfile::tempdir().unwrap();
    let f = fake(dir.path(), "bws", "{\"id\":\"abc\"}", "", 0);
    let v = vault("bitwarden-secrets", &f.bin);
    let err = fetch(v, "secret-id-123").unwrap_err();
    assert!(err.contains("value"), "{err}");
}

#[test]
fn bws_failure_error_has_no_value() {
    let dir = tempfile::tempdir().unwrap();
    let f = fake(dir.path(), "bws", VALUE, "access denied", 1);
    let v = vault("bitwarden-secrets", &f.bin);
    let err = fetch(v, "secret-id-123").unwrap_err();
    // Provider stderr is never quoted (H2: it can echo the secret being fetched), so
    // "access denied" no longer appears; the error names the program + exit status only.
    assert!(err.contains("bws") && err.contains("exited"), "{err}");
    assert!(!err.contains("access denied"), "{err}");
    assert!(!err.contains(VALUE), "{err}");
}

#[test]
fn bws_missing_program_install_hint() {
    let err = missing("bitwarden-secrets", "bws");
    assert!(err.contains("bws") && err.contains("install"), "{err}");
}

#[test]
fn keychain_with_account_exact_argv() {
    let dir = tempfile::tempdir().unwrap();
    let f = fake(dir.path(), "security", VALUE, "", 0);
    let mut v = vault("keychain", &f.bin);
    v.account = Some("kyle".into());
    assert_eq!(fetch(v, "myservice").unwrap(), VALUE);
    assert_eq!(
        argv(&f),
        vec![
            "find-generic-password",
            "-s",
            "myservice",
            "-a",
            "kyle",
            "-w"
        ]
    );
}

#[test]
fn keychain_without_account_exact_argv() {
    let dir = tempfile::tempdir().unwrap();
    let f = fake(dir.path(), "security", VALUE, "", 0);
    let v = vault("keychain", &f.bin);
    assert_eq!(fetch(v, "myservice").unwrap(), VALUE);
    assert_eq!(
        argv(&f),
        vec!["find-generic-password", "-s", "myservice", "-w"]
    );
}

#[test]
fn keychain_missing_program_hint() {
    let err = missing("keychain", "security");
    assert!(err.contains("security"), "{err}");
    assert!(!err.contains(VALUE), "{err}");
}

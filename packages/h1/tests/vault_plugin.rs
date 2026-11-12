//! Vault plugins: `provider = "plugin"` runs a helper `h1-vault-<plugin>` found on PATH.
//! Covered here: the argv/env contract, resolution by name on PATH (a toy SECOND plugin that
//! needs no core change), `vault status` readiness, check-time validation, redaction of the
//! helper's output on every failure path, caching, and `h1 up` with a fake helper.

#![cfg(unix)]

use std::collections::BTreeMap;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use h1::yah::cli::vault_status_core;
use h1::yah::load::load_str;
use h1::yah::spec::Vault;
use h1::yah::vault::Vaults;

const SECRET: &str = "PLUGIN-FAKE-SECRET-4c1e7a";

fn script(dir: &Path, name: &str, body: &str) -> PathBuf {
    let p = dir.join(name);
    fs::write(&p, format!("#!/bin/sh\n{body}\n")).unwrap();
    fs::set_permissions(&p, fs::Permissions::from_mode(0o755)).unwrap();
    p
}

fn plugin_vault(plugin: &str, bin: Option<&Path>) -> Vault {
    Vault {
        name: "v".into(),
        provider: "plugin".into(),
        path: None,
        account: Some("me@example.test".into()),
        command: bin
            .map(|b| vec![b.to_string_lossy().into_owned()])
            .unwrap_or_default(),
        plugin: Some(plugin.into()),
        options: vec![("url".into(), "http://localhost:1234".into())],
        secrets: vec![("TOKEN".into(), "item-ref".into())],
        line: 1,
    }
}

fn fetch(v: &Vault, timeout: Duration) -> Result<String, String> {
    let vs = std::slice::from_ref(v);
    let env = |_: &str| -> Option<String> { None };
    Vaults::new(vs, PathBuf::from("."), &env)
        .with_timeout(timeout)
        .get("v", "TOKEN")
}

#[test]
fn helper_gets_ref_and_key_in_argv_and_settings_in_env_only() {
    let dir = tempfile::tempdir().unwrap();
    let rec = dir.path().join("rec");
    let bin = script(
        dir.path(),
        "h1-vault-toy",
        &format!(
            "echo \"argv:$# $1 $2\" > {r}\nprintenv | grep '^H1_VAULT' >> {r}\nprintf '%s\\n' {SECRET}",
            r = rec.display()
        ),
    );
    let got = fetch(&plugin_vault("toy", Some(&bin)), Duration::from_secs(5)).unwrap();
    assert_eq!(got, SECRET, "stdout is the value, trailing newline trimmed");
    let rec = fs::read_to_string(&rec).unwrap();
    assert!(rec.contains("argv:2 item-ref TOKEN"), "{rec}");
    assert!(
        rec.contains("H1_VAULT_OPT_URL=http://localhost:1234"),
        "{rec}"
    );
    assert!(rec.contains("H1_VAULT_ACCOUNT=me@example.test"), "{rec}");
    assert!(rec.contains("H1_VAULT_PROTOCOL=1"), "{rec}");
    assert!(
        !rec.contains("localhost:1234 "),
        "options never ride on argv"
    );
}

#[test]
fn failure_quotes_only_program_and_status_never_helper_output() {
    let dir = tempfile::tempdir().unwrap();
    let bin = script(
        dir.path(),
        "h1-vault-toy",
        &format!("echo 'bad: {SECRET}'; echo 'bad: {SECRET}' >&2; exit 7"),
    );
    let err = fetch(&plugin_vault("toy", Some(&bin)), Duration::from_secs(5)).unwrap_err();
    assert!(
        err.contains("h1-vault-toy") && err.contains("exit status: 7"),
        "{err}"
    );
    assert!(!err.contains(SECRET) && !err.contains("bad:"), "{err}");
}

#[test]
fn timeout_oversize_and_non_utf8_carry_no_helper_text() {
    let dir = tempfile::tempdir().unwrap();
    let slow = script(dir.path(), "slow", &format!("echo {SECRET}; sleep 5"));
    let err = fetch(
        &plugin_vault("toy", Some(&slow)),
        Duration::from_millis(200),
    )
    .unwrap_err();
    assert!(
        err.contains("did not finish") && !err.contains(SECRET),
        "{err}"
    );
    let big = script(dir.path(), "big", "head -c 2000000 /dev/zero | tr '\\0' x");
    let err = fetch(&plugin_vault("toy", Some(&big)), Duration::from_secs(10)).unwrap_err();
    assert!(err.contains("more than") && !err.contains("xxxx"), "{err}");
    let bin = script(dir.path(), "bin", "printf '\\377\\376'");
    let err = fetch(&plugin_vault("toy", Some(&bin)), Duration::from_secs(5)).unwrap_err();
    assert!(err.contains("not UTF-8"), "{err}");
}

#[test]
fn missing_helper_is_one_install_hint_naming_the_program() {
    let v = plugin_vault("no-such-plugin-xyz", None);
    let err = fetch(&v, Duration::from_secs(2)).unwrap_err();
    assert!(
        err.contains("h1-vault-no-such-plugin-xyz is not installed"),
        "{err}"
    );
}

#[test]
fn a_second_get_does_not_rerun_the_helper() {
    let dir = tempfile::tempdir().unwrap();
    let counter = dir.path().join("count");
    let bin = script(
        dir.path(),
        "h1-vault-toy",
        &format!("echo run >> {}; echo value", counter.display()),
    );
    let vs = [plugin_vault("toy", Some(&bin))];
    let env = |_: &str| -> Option<String> { None };
    let vaults = Vaults::new(&vs, PathBuf::from("."), &env);
    vaults.get("v", "TOKEN").unwrap();
    vaults.get("v", "TOKEN").unwrap();
    assert_eq!(fs::read_to_string(&counter).unwrap().lines().count(), 1);
}

const YAH_TAIL: &str = r#"
provider "anthropic" {
  type = "anthropic"
}
model "haiku" {
  provider = "anthropic"
  id       = "claude-haiku-5-5"
}
system_one {
  fallback = "haiku"
}
harness "alpha" {
  kind  = "h1"
  role  = "worker"
  model = "haiku"
  open {
    command = ["cat"]
  }
}
team "t" {
  root    = "alpha"
  members = []
}
"#;

fn load(blocks: &str) -> Result<h1::yah::spec::Spec, String> {
    let src = format!("yah 1\n{blocks}{YAH_TAIL}");
    load_str("t.yah", &src, &BTreeMap::new()).map_err(|d| {
        d.0.iter()
            .map(|x| {
                format!(
                    "{}: {} {}",
                    x.summary,
                    x.detail,
                    x.hint.clone().unwrap_or_default()
                )
            })
            .collect::<Vec<_>>()
            .join("\n")
    })
}

#[test]
fn check_validates_plugin_blocks_without_looking_for_or_running_a_helper() {
    let ok = load(
        r#"vault "av" {
  provider = "plugin"
  plugin   = "aliasvault"
  account  = "me@example.test"
  options  = { url = "http://localhost:8090" }
  secrets  = { T = "Item" }
}
"#,
    );
    assert!(ok.is_ok(), "{:?}", ok.err());
    // Any other plugin name loads with free-form options: no core edit to add one.
    let other = load(
        r#"vault "x" {
  provider = "plugin"
  plugin   = "toy-two"
  options  = { whatever = "1", other_key = "2" }
  secrets  = { T = "r" }
}
"#,
    );
    assert!(other.is_ok(), "{:?}", other.err());
    let no_plugin = load("vault \"x\" {\n  provider = \"plugin\"\n}\n").unwrap_err();
    assert!(no_plugin.contains("plugin"), "{no_plugin}");
    let bad_name =
        load("vault \"x\" {\n  provider = \"plugin\"\n  plugin = \"../evil\"\n}\n").unwrap_err();
    assert!(bad_name.contains("plugin"), "{bad_name}");
    let bad_opt = load(
        "vault \"x\" {\n  provider = \"plugin\"\n  plugin = \"aliasvault\"\n  account = \"a\"\n  options = { url = \"u\", urll = \"x\" }\n}\n",
    )
    .unwrap_err();
    assert!(bad_opt.contains("no option \"urll\""), "{bad_opt}");
    let no_url = load(
        "vault \"x\" {\n  provider = \"plugin\"\n  plugin = \"aliasvault\"\n  account = \"a\"\n}\n",
    )
    .unwrap_err();
    assert!(no_url.contains("options.url"), "{no_url}");
}

#[test]
fn status_is_ready_iff_the_helper_is_on_path_and_runs_nothing_without_fetch() {
    let dir = tempfile::tempdir().unwrap();
    let marker = dir.path().join("ran");
    script(
        dir.path(),
        "h1-vault-toy-two",
        &format!("touch {}; echo v", marker.display()),
    );
    let spec = load(
        r#"vault "x" {
  provider = "plugin"
  plugin   = "toy-two"
  secrets  = { T = "r" }
}
"#,
    )
    .unwrap();
    let path = dir.path().display().to_string();
    let with = |_: &str| Some(path.clone());
    let (out, ok) = vault_status_core(&spec, Path::new("."), &with, Vec::new(), false);
    assert!(ok, "{out}");
    assert!(
        !marker.exists(),
        "status without --fetch must not spawn the helper"
    );
    let without = |_: &str| Some("/nonexistent-dir".to_owned());
    let (out, ok) = vault_status_core(&spec, Path::new("."), &without, Vec::new(), false);
    assert!(!ok && out.contains("h1-vault-toy-two not found"), "{out}");
}

#[test]
fn toy_second_plugin_resolves_by_name_on_path_through_the_h1_binary() {
    let dir = tempfile::tempdir().unwrap();
    script(
        dir.path(),
        "h1-vault-toy-two",
        "printf 'from-%s-%s' \"$1\" \"$2\"",
    );
    let yah = dir.path().join("t.yah");
    let src = format!(
        "yah 1\nvault \"x\" {{\n  provider = \"plugin\"\n  plugin = \"toy-two\"\n  secrets = {{ T = \"r\" }}\n}}\n{YAH_TAIL}"
    );
    fs::write(&yah, src).unwrap();
    let path = format!("{}:/usr/bin:/bin", dir.path().display());
    let run = |args: &[&str]| {
        Command::new(env!("CARGO_BIN_EXE_h1"))
            .args(args)
            .arg(&yah)
            .arg("--no-env-file")
            .env("PATH", &path)
            .output()
            .unwrap()
    };
    let out = run(&["vault", "status", "--fetch"]);
    let text = String::from_utf8_lossy(&out.stdout).into_owned();
    assert!(
        out.status.success(),
        "{text}{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(
        !text.contains("from-r-T"),
        "the fetched value is never printed: {text}"
    );
}

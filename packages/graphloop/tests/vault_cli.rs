//! Integration tests for `graphloop vault status` (`graphloop::cli::vault_status_core`).
//!
//! Contract: without `--fetch` only presence is checked and no provider runs; with
//! `--fetch` each declared key is fetched. Either way one line is printed per vault and
//! per key, the bool is true only when every line is ok/ready, and a secret VALUE never
//! appears in the output (fetched values are scrubbed).

use std::collections::BTreeMap;
use std::path::Path;

use graphloop::cli::vault_status_core;
use graphloop::load::load_str;
use graphloop::spec::{Spec, Vault};

const SECRET: &str = "s3cr3t-token-9f2a";

const SKELETON_TAIL: &str = r#"
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

fn load(vault_blocks: &str) -> Spec {
    let src = format!("yah 1\n{vault_blocks}{SKELETON_TAIL}");
    load_str("t.yah", &src, &BTreeMap::new()).map_err(|d| d.0.iter().map(|x| format!("{}: {} {}", x.line, x.summary, x.detail)).collect::<Vec<_>>().join("\n")).unwrap()
}

fn no_env(_: &str) -> Option<String> { None }

const DOTENV_VAULT: &str = r#"
vault "local" {
  provider = "dotenv"
  path     = "fleet.env"
  secrets  = {
    FLEET_TOKEN = "FLEET_TOKEN"
    GH_TOKEN    = "GITHUB_TOKEN"
  }
}
"#;

#[test]
fn dotenv_status_without_fetch_reports_ok_and_missing_without_values() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("fleet.env"), format!("FLEET_TOKEN={SECRET}\n")).unwrap();
    let spec = load(DOTENV_VAULT);
    let (out, ok) = vault_status_core(&spec, dir.path(), &no_env, vec![], false);
    assert!(!ok, "{out}");
    assert!(out.contains("vault local (dotenv): ready\n"), "{out}");
    assert!(out.contains("local FLEET_TOKEN: ok\n"), "{out}");
    assert!(out.contains("local GH_TOKEN: missing\n"), "{out}");
    assert!(!out.contains(SECRET), "{out}");
}

#[test]
fn dotenv_status_with_fetch_is_ok_only_when_every_key_fetches() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("fleet.env"), format!("FLEET_TOKEN={SECRET}\nGITHUB_TOKEN={SECRET}-gh\n")).unwrap();
    let spec = load(DOTENV_VAULT);
    let (out, ok) = vault_status_core(&spec, dir.path(), &no_env, vec![], true);
    assert!(ok, "{out}");
    assert!(out.contains("local FLEET_TOKEN: ok\n"), "{out}");
    assert!(out.contains("local GH_TOKEN: ok\n"), "{out}");
    assert!(!out.contains(SECRET), "{out}");
    std::fs::write(dir.path().join("fleet.env"), format!("FLEET_TOKEN={SECRET}\n")).unwrap();
    let (out, ok) = vault_status_core(&spec, dir.path(), &no_env, vec![], true);
    assert!(!ok, "{out}");
    assert!(out.contains("local GH_TOKEN: error:"), "{out}");
    assert!(!out.contains(SECRET), "{out}");
}

#[test]
fn dotenv_status_with_a_missing_file_is_not_ready() {
    let dir = tempfile::tempdir().unwrap();
    let spec = load(DOTENV_VAULT);
    let (out, ok) = vault_status_core(&spec, dir.path(), &no_env, vec![], false);
    assert!(!ok, "{out}");
    assert!(out.contains("vault local (dotenv): not ready: cannot read"), "{out}");
    assert!(out.contains("local FLEET_TOKEN: error: cannot read"), "{out}");
}

#[test]
fn env_status_reads_references_from_the_environment() {
    let spec = load("\nvault \"any\" {\n  provider = \"env\"\n  secrets  = {\n    PRESENT = \"PRESENT_VAR\"\n    ABSENT  = \"ABSENT_VAR\"\n  }\n}\n");
    let env = |name: &str| -> Option<String> { if name == "PRESENT_VAR" { Some(SECRET.into()) } else { None } };
    let (out, ok) = vault_status_core(&spec, Path::new("."), &env, vec![], false);
    assert!(!ok, "{out}");
    assert!(out.contains("vault any (env): ready\n"), "{out}");
    assert!(out.contains("any PRESENT: ok\n"), "{out}");
    assert!(out.contains("any ABSENT: missing\n"), "{out}");
    assert!(!out.contains(SECRET), "{out}");
}

#[test]
fn command_status_checks_the_program_and_fetch_never_prints_the_value() {
    let spec = load("\nvault \"cmd\" {\n  provider = \"command\"\n  command  = [\"printf\", \"cmd-s3cr3t-9f2a\"]\n  secrets  = {\n    TOKEN = \"TOKEN\"\n  }\n}\n");
    let real = |name: &str| std::env::var(name).ok();
    let (out, ok) = vault_status_core(&spec, Path::new("."), &real, vec![], false);
    assert!(ok, "{out}");
    assert!(out.contains("vault cmd (command): ready\n"), "{out}");
    assert!(out.contains("cmd TOKEN: ok\n"), "{out}");
    let (out, ok) = vault_status_core(&spec, Path::new("."), &real, vec![], true);
    assert!(ok, "{out}");
    assert!(out.contains("cmd TOKEN: ok\n"), "{out}");
    assert!(!out.contains("cmd-s3cr3t-9f2a"), "{out}");
}

#[test]
fn command_status_with_a_missing_program_is_not_ready() {
    let spec = load("\nvault \"cmd\" {\n  provider = \"command\"\n  command  = [\"graphloop-no-such-program-9f2a\"]\n  secrets  = {\n    TOKEN = \"TOKEN\"\n  }\n}\n");
    let real = |name: &str| std::env::var(name).ok();
    let (out, ok) = vault_status_core(&spec, Path::new("."), &real, vec![], false);
    assert!(!ok, "{out}");
    assert!(out.contains("vault cmd (command): not ready: program graphloop-no-such-program-9f2a not found"), "{out}");
    assert!(out.contains("cmd TOKEN: error: program graphloop-no-such-program-9f2a not found"), "{out}");
}

#[test]
fn unsupported_provider_is_not_ready() {
    // Schema rejects unknown providers at load, so build the Spec directly: vault_status_core must still report a hand-built/forward Spec as not ready.
    let mut spec = load("");
    spec.vaults.push(Vault { name: "op".into(), provider: "1password".into(), path: None, account: None, command: vec![], secrets: vec![("TOKEN".into(), "op://vault/item/token".into())], line: 1 });
    let (out, ok) = vault_status_core(&spec, Path::new("."), &no_env, vec![], false);
    assert!(!ok, "{out}");
    assert!(out.contains("vault op (1password): not ready: provider \"1password\" is not available in this build"), "{out}");
    assert!(out.contains("op TOKEN: error: provider \"1password\" is not available in this build"), "{out}");
}

#[test]
fn no_vaults_declared_is_ok() {
    let spec = load("");
    let (out, ok) = vault_status_core(&spec, Path::new("."), &no_env, vec![], false);
    assert!(ok, "{out}");
    assert_eq!(out, "no vaults declared\n");
}

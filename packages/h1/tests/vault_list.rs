//! Integration tests for `graphloop vault list` (`h1::yah::cli::vault_list_core`).
//!
//! Contract: a pure declaration inventory — one `<vault>\t<provider>\t<key>` line per
//! declared secret key, sorted by vault then key; a vault with no `secrets` map prints
//! key `-`; a file with no vaults exits 0 with empty output; a bad file exits non-zero.
//! It never fetches, never spawns a provider program, and never prints a secret value
//! or a provider-side reference — only key NAMES.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use h1::yah::cli::vault_list_core;
use h1::yah::load::load_str;
use h1::yah::spec::Spec;

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
    load_str("t.yah", &src, &BTreeMap::new())
        .map_err(|d| {
            d.0.iter()
                .map(|x| format!("{}: {} {}", x.line, x.summary, x.detail))
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap()
}

fn write_yah(dir: &Path, vault_blocks: &str) -> PathBuf {
    let file = dir.join("t.yah");
    std::fs::write(&file, format!("yah 1\n{vault_blocks}{SKELETON_TAIL}")).unwrap();
    file
}

fn run_list(file: &Path) -> Output {
    Command::new(env!("CARGO_BIN_EXE_h1"))
        .args(["vault", "list"])
        .arg(file)
        .output()
        .unwrap()
}

#[test]
fn list_is_sorted_by_vault_then_key_and_prints_key_names_only() {
    // Declared out of order on purpose; refs are distinct from keys and must not appear.
    let spec = load(
        "\nvault \"zeta\" {\n  provider = \"env\"\n  secrets  = {\n    ZEBRA = \"ZEBRA_REF_HIDDEN\"\n    APPLE = \"APPLE_REF_HIDDEN\"\n  }\n}\n\nvault \"alpha\" {\n  provider = \"dotenv\"\n  path     = \"fleet.env\"\n  secrets  = {\n    GH_TOKEN    = \"GITHUB_TOKEN_HIDDEN\"\n    FLEET_TOKEN = \"FLEET_REF_HIDDEN\"\n  }\n}\n\nvault \"mid\" {\n  provider = \"env\"\n}\n",
    );
    let out = vault_list_core(&spec);
    assert_eq!(
        out,
        "alpha\tdotenv\tFLEET_TOKEN\nalpha\tdotenv\tGH_TOKEN\nmid\tenv\t-\nzeta\tenv\tAPPLE\nzeta\tenv\tZEBRA\n",
        "{out}"
    );
    assert!(!out.contains("HIDDEN"), "{out}");
}

#[test]
fn list_for_a_vault_without_secrets_prints_dash() {
    let spec = load("\nvault \"any\" {\n  provider = \"env\"\n}\n");
    assert_eq!(vault_list_core(&spec), "any\tenv\t-\n");
}

#[test]
fn list_with_no_vaults_is_empty() {
    let spec = load("");
    assert_eq!(vault_list_core(&spec), "");
}

#[test]
fn binary_no_vault_file_exits_zero_with_empty_output() {
    let dir = tempfile::tempdir().unwrap();
    let file = write_yah(dir.path(), "");
    let out = run_list(&file);
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert_eq!(String::from_utf8_lossy(&out.stdout), "");
}

#[test]
fn binary_command_vault_never_runs_the_provider() {
    let dir = tempfile::tempdir().unwrap();
    let invoked = dir.path().join("invoked");
    let script = dir.path().join("provider.sh");
    std::fs::write(
        &script,
        format!(
            "#!/bin/sh\ntouch \"{}\"\necho PROVIDER_RAN_SENTINEL\nexit 99\n",
            invoked.display()
        ),
    )
    .unwrap();
    let blocks = format!(
        "\nvault \"cmdv\" {{\n  provider = \"command\"\n  command  = [\"sh\", \"{}\", \"{{ref}}\"]\n  secrets  = {{\n    TOKEN = \"TOKEN_REF_SENTINEL\"\n  }}\n}}\n",
        script.display()
    );
    let file = write_yah(dir.path(), &blocks);
    let out = run_list(&file);
    let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&out.stderr).into_owned();
    assert!(out.status.success(), "{stderr}");
    assert_eq!(stdout, "cmdv\tcommand\tTOKEN\n", "{stdout}");
    assert!(!invoked.exists(), "provider script was executed");
    assert!(
        !stdout.contains("SENTINEL") && !stderr.contains("SENTINEL"),
        "{stdout} {stderr}"
    );
}

#[test]
fn binary_bad_or_missing_file_exits_nonzero() {
    let dir = tempfile::tempdir().unwrap();
    let bad = dir.path().join("bad.yah");
    std::fs::write(&bad, "yah 1\nthis is not valid {{{\n").unwrap();
    let out = run_list(&bad);
    assert!(
        !out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stdout)
    );
    assert!(!out.stderr.is_empty(), "expected diagnostics on stderr");
    let out = run_list(&dir.path().join("no-such-file.yah"));
    assert!(!out.status.success());
}

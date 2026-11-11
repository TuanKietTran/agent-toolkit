//! Golden tests for `graphloop preview`.
//!
//! Goldens: `tests/fixtures/preview/<example-stem>.json`, one per file in
//! `examples/`. Hand-derived from the shared contract in `src/preview.rs`
//! and the as-written harness blocks (NOT from `plan --json`: plan resolves
//! models through system-one, preview never calls the picker, so a harness
//! with `model = "system-one"` is `pending` with `model: null` here).
//! Pending-node `open_command`s render `--model system-one`: the
//! builder substitutes `${harnesses.<name>.model_id}` with the requested
//! model. Warning `message` wording is likewise the builder's. Goldens
//! were hand-derived, then regenerated against the merged builder and
//! the diff reviewed: only that substitution differed semantically.
//!
//! Two tests:
//! - `golden_fixtures_parse_and_satisfy_contract_invariants` always runs:
//!   every fixture parses as `h1::yah::preview::Preview` and satisfies
//!   the contract invariants (version, source, model-status coherence,
//!   secret-literal masking, warning sort order and severity mapping).
//! - `preview_cli_matches_goldens_when_available` is gated on the preview
//!   subcommand existing: if the binary rejects `preview`, it prints
//!   `PREVIEW_SKIPPED` and passes, the same gate pattern as `H1_BIN` in
//!   `vault_up_real_h1.rs`. `UPDATE_GOLDEN=1 cargo test --test
//!   preview_golden` regenerates the fixtures; review that diff before
//!   committing it.

use std::collections::BTreeSet;
use std::path::PathBuf;
use std::process::Command;

use h1::yah::preview::{EnvSource, ModelStatus, Preview, Severity, WarningCode};

fn pkg() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn examples() -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = std::fs::read_dir(pkg().join("examples"))
        .unwrap()
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|x| x == "yah"))
        .collect();
    out.sort();
    out
}

fn golden_path(stem: &str) -> PathBuf {
    pkg()
        .join("tests/fixtures/preview")
        .join(format!("{stem}.json"))
}

fn load_golden(stem: &str) -> Preview {
    let text = std::fs::read_to_string(golden_path(stem))
        .unwrap_or_else(|e| panic!("golden for {stem}: {e}"));
    serde_json::from_str(&text)
        .unwrap_or_else(|e| panic!("golden for {stem} does not parse as Preview: {e}"))
}

fn secretish(key: &str) -> bool {
    let up = key.to_ascii_uppercase();
    ["KEY", "TOKEN", "SECRET", "PASSWORD", "PASSWD"]
        .iter()
        .any(|w| up.contains(w))
}

#[test]
fn golden_fixtures_parse_and_satisfy_contract_invariants() {
    let mut covered = BTreeSet::new();
    for ex in examples() {
        let stem = ex.file_stem().unwrap().to_string_lossy().into_owned();
        covered.insert(stem.clone());
        let p = load_golden(&stem);
        assert_eq!(p.version, 1, "{stem}");
        assert_eq!(p.source, format!("examples/{stem}.yah"), "{stem}");
        assert_eq!(p.prefix, None, "{stem}");
        assert!(!p.nodes.is_empty(), "{stem}: no nodes");
        assert_eq!(
            p.nodes[0].name, p.root,
            "{stem}: root must be first (plan order)"
        );
        assert_eq!(p.nodes[0].parent, None, "{stem}: root has a parent");
        let names: BTreeSet<&str> = p.nodes.iter().map(|n| n.name.as_str()).collect();
        for n in &p.nodes {
            assert!(
                n.open_command
                    .starts_with(&format!("h1 open -n {} --role {}", n.name, n.role)),
                "{stem}: bad open_command for {}: {}",
                n.name,
                n.open_command
            );
            match n.model_status {
                ModelStatus::Pinned => {
                    assert!(
                        n.model.is_some() && n.model_label.is_some(),
                        "{stem}: pinned without model"
                    );
                    assert_ne!(n.requested_model, "system-one", "{stem}");
                }
                ModelStatus::Pending => {
                    assert_eq!(n.requested_model, "system-one", "{stem}");
                    assert!(
                        n.model.is_none() && n.model_label.is_none(),
                        "{stem}: pending with a model"
                    );
                }
                ModelStatus::Unknown => {
                    assert!(n.model.is_none(), "{stem}: unknown with a model");
                }
            }
            let mut keys = BTreeSet::new();
            for e in &n.env {
                assert!(
                    keys.insert(e.key.clone()),
                    "{stem}: duplicate env key {}",
                    e.key
                );
                if e.masked {
                    assert_eq!(e.value, "***", "{stem}: masked env {} is not ***", e.key);
                }
                if e.source == EnvSource::Literal && secretish(&e.key) {
                    assert!(
                        e.masked,
                        "{stem}: secret-looking literal {} is unmasked",
                        e.key
                    );
                }
            }
        }
        for e in &p.edges {
            assert!(
                names.contains(e.from.as_str()) && names.contains(e.to.as_str()),
                "{stem}: edge to unknown node"
            );
            assert!(
                e.kind == "parent" || e.kind == "member",
                "{stem}: bad edge kind {}",
                e.kind
            );
        }
        let sort_keys: Vec<(Option<String>, String)> = p
            .warnings
            .iter()
            .map(|w| (w.node.clone(), format!("{:?}", w.code)))
            .collect();
        let mut sorted = sort_keys.clone();
        sorted.sort();
        assert_eq!(
            sort_keys, sorted,
            "{stem}: warnings not sorted by (node, code)"
        );
        for w in &p.warnings {
            let expect_error = matches!(
                w.code,
                WarningCode::Cycle | WarningCode::DuplicateSession | WarningCode::Invalid
            );
            assert_eq!(
                w.severity == Severity::Error,
                expect_error,
                "{stem}: severity/code mismatch for {:?}",
                w.code
            );
        }
    }
    assert!(
        covered.len() >= 6,
        "expected goldens for all examples, got {covered:?}"
    );
}

#[test]
fn preview_cli_matches_goldens_when_available() {
    let bin = env!("CARGO_BIN_EXE_h1");
    let probe = Command::new(bin)
        .args(["preview", "examples/demo.yah"])
        .current_dir(pkg())
        .output()
        .unwrap();
    if !probe.status.success() {
        let err = String::from_utf8_lossy(&probe.stderr);
        if err.contains("unrecognized")
            || err.contains("unexpected argument")
            || err.contains("USAGE")
            || err.contains("Usage")
        {
            eprintln!(
                "PREVIEW_SKIPPED: preview subcommand not in this binary yet: {}",
                err.lines().next().unwrap_or("")
            );
            return;
        }
        panic!("preview probe failed for another reason: {err}");
    }
    let update = std::env::var("UPDATE_GOLDEN").is_ok_and(|v| v == "1");
    for ex in examples() {
        let stem = ex.file_stem().unwrap().to_string_lossy().into_owned();
        let source = format!("examples/{stem}.yah");
        let out = Command::new(bin)
            .args(["preview", &source])
            .current_dir(pkg())
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{stem}: preview exited {}: {}",
            out.status,
            String::from_utf8_lossy(&out.stderr)
        );
        let got: Preview = serde_json::from_slice(&out.stdout)
            .unwrap_or_else(|e| panic!("{stem}: preview output does not parse as Preview: {e}"));
        if update {
            std::fs::write(
                golden_path(&stem),
                serde_json::to_string_pretty(&got).unwrap() + "\n",
            )
            .unwrap();
        } else {
            assert_eq!(
                got,
                load_golden(&stem),
                "{stem}: preview output differs from golden; regenerate with UPDATE_GOLDEN=1 and review the diff"
            );
        }
    }
}

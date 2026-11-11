//! Golden tests for the graphloop examples, rendered through the
//! unified h1 binary's `check`/`plan`/`graph` commands (sg-qa #10).
//!
//! Goldens: `tests/golden/<example-stem>.txt`, one per entry in
//! `EXAMPLES`, holding the exact stdout of `h1 check`, `h1 plan` and
//! `h1 graph` in that order. They were generated from the standalone
//! graphloop binary before the fold (sg-merge); the folded commands
//! must not change them. `plan` is the through-h1 surface: every
//! non-comment line it prints must be an `h1 open ...` command.
//!
//! Examples are invoked by relative path from the graphloop crate
//! root, so outputs carry no absolute paths (the one location a
//! golden does pin is `research-team`'s `pinned in
//! examples/research-team.yah:48` plan comment). `plan`/`graph` are
//! read-only: nothing is opened. Until sg-merge lands the fold in
//! this binary the test fails on `unrecognized subcommand 'check'`:
//! no gating, by design.
//!
//! The signals example lives in this crate as
//! `examples/signals-pair.yah` (team `pair`, checked by the
//! graphloop binary in sg-qa); it joins `EXAMPLES` with a
//! regenerated golden when sg-merge re-points this test at the
//! folded examples directory.

use std::{
    fs,
    path::PathBuf,
    process::{Command, Output},
};

/// Every graphloop example, by stem. Single source of truth: a new
/// example is added here together with its golden in `tests/golden/`.
const EXAMPLES: &[&str] = &["demo", "renewable-team", "research-team", "team", "vault"];

fn binary() -> &'static str {
    env!("CARGO_BIN_EXE_h1")
}

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

/// The graphloop crate root (`packages/graphloop`), used as the
/// working directory so example paths stay relative (`examples/…`).
fn graphloop_root() -> PathBuf {
    root().join("../graphloop")
}

fn run(args: &[&str]) -> String {
    let output: Output = Command::new(binary())
        .args(args)
        .current_dir(graphloop_root())
        .env_remove("GRAPHLOOP_SYSTEM_ONE_DIR")
        .output()
        .expect("run h1");
    assert!(
        output.status.success(),
        "h1 {args:?} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).expect("h1 output is UTF-8")
}

#[test]
fn examples_check_plan_and_graph_match_their_goldens() {
    assert!(!EXAMPLES.is_empty(), "EXAMPLES is not empty");
    for stem in EXAMPLES {
        // The example and its golden must both exist.
        let example_path = graphloop_root().join(format!("examples/{stem}.yah"));
        assert!(
            example_path.is_file(),
            "{}: missing example",
            example_path.display()
        );
        let golden_path = root().join("tests/golden").join(format!("{stem}.txt"));
        let expected = fs::read_to_string(&golden_path)
            .unwrap_or_else(|error| panic!("{}: {error}", golden_path.display()));

        let relative = format!("examples/{stem}.yah");
        let check = run(&["check", &relative]);
        let plan = run(&["plan", &relative]);
        let graph = run(&["graph", &relative]);

        // Through-h1 invariant: plan prints only comments and
        // `h1 open ...` commands, one per harness in the team.
        let opens = plan
            .lines()
            .filter(|line| !line.is_empty() && !line.starts_with('#'))
            .inspect(|line| {
                assert!(
                    line.starts_with("h1 open -n "),
                    "{stem}: plan line is not an h1 open command: {line}"
                )
            })
            .count();
        assert!(opens > 0, "{stem}: plan opens at least one session");

        let actual = format!("=== check ===\n{check}=== plan ===\n{plan}=== graph ===\n{graph}");
        assert_eq!(
            actual, expected,
            "golden mismatch for {stem}: if the change is intentional, regenerate tests/golden/{stem}.txt from the graphloop binary"
        );
    }
}

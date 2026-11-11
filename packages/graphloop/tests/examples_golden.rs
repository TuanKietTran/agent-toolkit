//! Golden tests for the graphloop examples, rendered through the
//! commands that turn a team into h1 sessions (sg-qa #6).
//!
//! Goldens: `tests/fixtures/golden/<example-stem>.txt`, one per file
//! in `examples/`, holding the exact stdout of `check`, `plan` and
//! `graph` in that order. `plan` is the through-h1 surface: every
//! non-comment line it prints must be an `h1 open ...` command.
//!
//! The post-merge form of this test (one unified binary, sg-merge)
//! re-points `binary()` at that binary; the goldens do not change.
//! Examples are invoked by relative path from the crate root, so
//! outputs carry no absolute paths (the one location a golden does
//! pin is `research-team`'s `pinned in examples/research-team.yah:48`
//! plan comment). `plan`/`graph` are read-only: nothing is opened.

use std::{
    collections::BTreeSet,
    fs,
    path::PathBuf,
    process::{Command, Output},
};

fn binary() -> &'static str {
    env!("CARGO_BIN_EXE_graphloop")
}

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn run(args: &[&str]) -> String {
    let output: Output = Command::new(binary())
        .args(args)
        .current_dir(root())
        .env_remove("GRAPHLOOP_SYSTEM_ONE_DIR")
        .output()
        .expect("run graphloop");
    assert!(
        output.status.success(),
        "graphloop {args:?} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).expect("graphloop output is UTF-8")
}

fn stems(dir: &std::path::Path, extension: &str) -> BTreeSet<String> {
    fs::read_dir(dir)
        .unwrap_or_else(|error| panic!("{}: {error}", dir.display()))
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|ext| ext == extension))
        .map(|path| path.file_stem().unwrap().to_string_lossy().into_owned())
        .collect()
}

#[test]
fn examples_check_plan_and_graph_match_their_goldens() {
    let examples = stems(&root().join("examples"), "yah");
    let goldens = stems(&root().join("tests/fixtures/golden"), "txt");
    assert_eq!(
        examples, goldens,
        "every example has a golden and every golden has an example"
    );
    assert!(!examples.is_empty(), "examples/ is not empty");

    for stem in &examples {
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
        let golden_path = root()
            .join("tests/fixtures/golden")
            .join(format!("{stem}.txt"));
        let expected = fs::read_to_string(&golden_path)
            .unwrap_or_else(|error| panic!("{}: {error}", golden_path.display()));
        assert_eq!(
            actual, expected,
            "golden mismatch for {stem}: if the change is intentional, "
        );
    }
}

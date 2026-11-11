//! Shim parity: the deprecated `graphloop` bin must behave byte-for-byte
//! like `h1` for the yah CLI, apart from exactly one deprecation line on
//! stderr. Checked on `plan` for EVERY `examples/*.yah` in the crate:
//! stdout byte-identical, exit codes equal, shim stderr is exactly the
//! deprecation line, and `h1` itself succeeds with empty stderr.

use std::{
    fs,
    path::PathBuf,
    process::{Command, Output},
};

const DEPRECATION: &str =
    "graphloop is deprecated: use \"h1 <check|fmt|plan|up|down|graph|vault|runs|trace>\" instead";

fn run(bin: &str, example: &PathBuf) -> Output {
    Command::new(bin)
        .arg("plan")
        .arg(example)
        .output()
        .unwrap_or_else(|e| panic!("failed to spawn {bin}: {e}"))
}

#[test]
fn graphloop_shim_plan_matches_h1_on_every_example() {
    let examples_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("examples");
    let mut examples: Vec<PathBuf> = fs::read_dir(&examples_dir)
        .unwrap_or_else(|e| panic!("cannot read {}: {e}", examples_dir.display()))
        .filter_map(|entry| {
            let path = entry.ok()?.path();
            (path.extension().is_some_and(|ext| ext == "yah")).then_some(path)
        })
        .collect();
    examples.sort();
    assert!(
        examples.len() >= 5,
        "expected at least 5 .yah examples in {}, found {}",
        examples_dir.display(),
        examples.len()
    );

    for example in &examples {
        let name = example.display().to_string();
        let h1 = run(env!("CARGO_BIN_EXE_h1"), example);
        let shim = run(env!("CARGO_BIN_EXE_graphloop"), example);

        assert!(
            h1.status.success(),
            "h1 plan {name} failed: {}",
            String::from_utf8_lossy(&h1.stderr)
        );
        assert_eq!(
            shim.status.code(),
            h1.status.code(),
            "exit codes differ for {name}: shim {:?} vs h1 {:?}",
            shim.status.code(),
            h1.status.code()
        );
        assert_eq!(
            shim.stdout,
            h1.stdout,
            "stdout differs for {name}:\nshim:\n{}\nh1:\n{}",
            String::from_utf8_lossy(&shim.stdout),
            String::from_utf8_lossy(&h1.stdout)
        );
        assert!(
            !h1.stdout.is_empty(),
            "h1 plan {name} produced empty stdout, parity would be vacuous"
        );
        assert!(
            h1.stderr.is_empty(),
            "h1 plan {name} wrote to stderr: {}",
            String::from_utf8_lossy(&h1.stderr)
        );
        assert_eq!(
            shim.stderr,
            format!("{DEPRECATION}\n").into_bytes(),
            "shim stderr for {name} is not exactly the one deprecation line: {}",
            String::from_utf8_lossy(&shim.stderr)
        );
    }
}

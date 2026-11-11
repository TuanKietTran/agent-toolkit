//! Help text must not contain the pre-rename binary name in any spelling.
//!
//! The old name is assembled from its parts at runtime, so this file itself
//! stays clean under the fleet-wide grep for that name.

use std::process::{Command, Output};

/// Every subcommand, as listed by `h1 --help` (the `help` pseudo-command
/// prints the same texts and is not listed separately).
const SUBCOMMANDS: &[&str] = &[
    "run",
    "host",
    "send",
    "ask",
    "screen",
    "attach",
    "adopt",
    "foreground",
    "socket",
    "open",
    "list",
    "status",
    "agents",
    "console",
    "doctor",
    "stop",
    "key",
    "wait",
    "watch",
    "spawn",
    "checkpoint",
    "decide",
    "ledger",
    "close",
    "resume",
    "renew",
];

fn binary() -> &'static str {
    env!("CARGO_BIN_EXE_h1")
}

/// Runs `h1 [args] --help` and returns stdout plus stderr.
fn help(args: &[&str]) -> String {
    let output: Output = Command::new(binary())
        .args(args)
        .arg("--help")
        .output()
        .expect("run h1 --help");
    assert!(
        output.status.success(),
        "h1 {args:?} --help failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let mut text = String::from_utf8(output.stdout).expect("help is UTF-8");
    text.push_str(&String::from_utf8_lossy(&output.stderr));
    text
}

/// The stale name with each separator spelling, lower-case. Callers compare
/// against lower-cased help text, so upper-case spellings are covered too.
fn stale_names() -> Vec<String> {
    let parts = ["agent", "cli", "lab"];
    ["-", "_", " ", ""]
        .iter()
        .map(|separator| parts.join(separator))
        .collect()
}

#[test]
fn help_text_has_no_stale_name() {
    let mut cases: Vec<Vec<&str>> = vec![Vec::new()];
    cases.extend(SUBCOMMANDS.iter().map(|name| vec![*name]));
    for args in &cases {
        let text = help(args);
        assert!(
            text.contains("Usage: h1"),
            "help for {args:?} has no usage line:\n{text}"
        );
        let lower = text.to_lowercase();
        for needle in stale_names() {
            assert!(
                !lower.contains(&needle),
                "stale name {needle:?} in help for {args:?}:\n{text}"
            );
        }
    }
}

#[test]
fn top_level_help_lists_every_subcommand() {
    let text = help(&[]);
    for name in SUBCOMMANDS {
        assert!(
            text.lines().any(|line| line.trim_start().starts_with(name)),
            "top-level help does not list {name}:\n{text}"
        );
    }
}

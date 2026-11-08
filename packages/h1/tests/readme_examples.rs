//! R22: the fenced `h1 ...` examples in README.md are executable.
//!
//! Extraction: every line inside a fenced code block in README.md whose trimmed form starts
//! with `h1 ` is an extracted command (trailing ` # ...` comments are stripped). Lines that do
//! not start with `h1` (`printf ... | h1 run`, `mv ...`, `cargo ...`) are not extracted.
//!
//! Every extracted command is accounted for exactly once: it is either in `RUN_VERBATIM`
//! (executed as written against a private `H1_DIR`), or in `SKIPPED` with a recorded reason.
//! An extracted command in neither list — or in both — fails the classification test, so a new
//! README example can never slip in silently.
//!
//! On top of the verbatim runs, the safe set from the brief is executed:
//! - `--help` for the top level and for every subcommand named by an extracted command;
//! - a full named-session lifecycle (`open` / `send` / `screen` / `status` / `stop`, the forms
//!   of the README's named-session block) on a disposable `cat` lab, with
//!   `H1_DIR=/tmp/h1-rd` (short path, for socket length limits).
//!   Adaptations versus the README text: `--detached` is added so no visible window opens,
//!   and the lab is named `readme-cat` running `cat` instead of `ux` running `pi`.
//!
//! The lifecycle test always stops its lab and removes `h1-rd`, and no test ever touches the
//! default/fleet `H1_DIR`.

use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Output, Stdio},
    thread,
    time::{Duration, Instant},
};

const TIMEOUT: Duration = Duration::from_secs(60);
const LIFECYCLE_DIR: &str = "/tmp/h1-rd";
const LIFECYCLE_NAME: &str = "readme-cat";

fn binary() -> &'static str {
    env!("CARGO_BIN_EXE_h1")
}

fn extract_readme_h1_commands() -> Vec<String> {
    let path: PathBuf = Path::new(env!("CARGO_MANIFEST_DIR")).join("README.md");
    let text = fs::read_to_string(&path).unwrap();
    let mut in_fence = false;
    let mut commands = Vec::new();
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("```") {
            in_fence = !in_fence;
            continue;
        }
        if !in_fence || !trimmed.starts_with("h1 ") {
            continue;
        }
        let command = match trimmed.find(" #") {
            Some(index) => trimmed[..index].trim_end(),
            None => trimmed,
        };
        commands.push(command.to_string());
    }
    commands
}

/// The exact extracted commands, in README order. A README edit that adds, removes or
/// rewords an example fails here until it is classified below.
const EXPECTED: &[&str] = &[
    "h1 run -- command --flag",
    "h1 run --record session.jsonl -- command",
    "h1 host -r pi.jsonl -- pi --no-session",
    "h1 send -e 'Reply exactly: HELLO'",
    "h1 screen",
    "h1 attach",
    "h1 send -e '/exit'",
    "h1 open -n ux --title \"ux lab\" --cwd D:\\work -- pi --no-session",
    "h1 list",
    "h1 send -n ux --paced --file brief.txt -e",
    "h1 key  -n ux Down*2 Enter",
    "h1 wait -n ux --asking",
    "h1 watch -n ux",
    "h1 status -n ux --json",
    "h1 screen -n ux --tail 12 --compact",
    "h1 stop -n ux",
    "h1 console",
    "h1 console --here",
    "h1 console --snapshot --view graph --width 130 --height 30",
    "h1 agents",
    "h1 agents --json",
    "h1 agents --publish --watch 5",
    "h1 console --view agents",
    "h1 doctor",
];

/// Extracted commands executed exactly as written (against a private `H1_DIR`).
const RUN_VERBATIM: &[&str] = &["h1 list"];

/// Every other extracted command, with the reason it is not run verbatim. Where a command's
/// form is exercised by the lifecycle test instead, the reason says so.
const SKIPPED: &[(&str, &str)] = &[
    (
        "h1 run -- command --flag",
        "placeholder program `command` is not a real executable, and `run` is an interactive proxy",
    ),
    (
        "h1 run --record session.jsonl -- command",
        "placeholder program `command` is not a real executable, and it would write session.jsonl into the working directory",
    ),
    (
        "h1 host -r pi.jsonl -- pi --no-session",
        "needs the pi agent CLI and a real model session, and it would use the default socket instead of a private H1_DIR",
    ),
    (
        "h1 send -e 'Reply exactly: HELLO'",
        "targets the default-socket host from the preceding example, not a private-H1_DIR session; the send form is exercised on the cat lab",
    ),
    (
        "h1 screen",
        "targets the default-socket host from the preceding example and fails with no such host; the screen form is exercised on the cat lab",
    ),
    (
        "h1 attach",
        "requires terminal stdin and foregrounds the hosted PTY interactively until Ctrl-]",
    ),
    (
        "h1 send -e '/exit'",
        "targets the default-socket host from the preceding example, not a private-H1_DIR session",
    ),
    (
        "h1 open -n ux --title \"ux lab\" --cwd D:\\work -- pi --no-session",
        "needs the pi agent CLI, uses the Windows path D:\\work, and opens a visible window; the open form is exercised on the cat lab",
    ),
    (
        "h1 send -n ux --paced --file brief.txt -e",
        "needs brief.txt and the running pi ux session; the send form is exercised on the cat lab",
    ),
    (
        "h1 key  -n ux Down*2 Enter",
        "needs the running ux session, which this test never starts",
    ),
    (
        "h1 wait -n ux --asking",
        "needs the running ux session and blocks until a dialog appears (exit 124 on timeout)",
    ),
    (
        "h1 watch -n ux",
        "needs the running ux session and watches forever; it does not terminate",
    ),
    (
        "h1 status -n ux --json",
        "needs the running ux session; the status --json form is exercised on the cat lab",
    ),
    (
        "h1 screen -n ux --tail 12 --compact",
        "needs the running ux session; the screen --tail --compact form is exercised on the cat lab",
    ),
    (
        "h1 stop -n ux",
        "needs the running ux session; the stop form is exercised on the cat lab",
    ),
    (
        "h1 console",
        "opens the interactive console TUI in a new terminal window",
    ),
    (
        "h1 console --here",
        "takes over the current terminal with the interactive console TUI",
    ),
    (
        "h1 console --snapshot --view graph --width 130 --height 30",
        "console family is outside this test's safe set (the other console forms are interactive); the snapshot form was verified manually, exit 0, on 2026-11-08",
    ),
    (
        "h1 agents",
        "scans every process on the machine, outside the private-H1_DIR safe set",
    ),
    (
        "h1 agents --json",
        "scans every process on the machine, outside the private-H1_DIR safe set",
    ),
    (
        "h1 agents --publish --watch 5",
        "writes agents.json into the real ~/.h1 session directory and then watches forever; both are forbidden here",
    ),
    (
        "h1 console --view agents",
        "opens the interactive console TUI in a new terminal window",
    ),
    (
        "h1 doctor",
        "its exit code depends on the real machine state it diagnoses (real HOME, PATH binaries, skill links, lab-gui port probe), so it cannot be asserted successful verbatim; its checks are exercised by the doctor unit tests against temp dirs",
    ),
];

/// Subcommands named by the extracted commands; each one's `--help` is run.
const HELP_SUBCOMMANDS: &[&str] = &[
    "run", "host", "send", "screen", "attach", "open", "list", "key", "wait", "watch", "status",
    "stop", "console", "agents", "doctor",
];

fn run_in(dir: &Path, args: &[&str]) -> Output {
    Command::new(binary())
        .env("H1_DIR", dir)
        .env_remove("H1_SOCKET")
        .env_remove("H1_NAME")
        .args(args)
        .stdin(Stdio::null())
        .output()
        .unwrap()
}

fn assert_success(dir: &Path, args: &[&str]) -> Output {
    let output = run_in(dir, args);
    assert!(
        output.status.success(),
        "{args:?} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    output
}

fn wait_until(mut condition: impl FnMut() -> bool) {
    let start = Instant::now();
    while !condition() {
        assert!(start.elapsed() < TIMEOUT, "condition timed out");
        thread::sleep(Duration::from_millis(30));
    }
}

#[test]
fn every_readme_example_is_classified_run_or_skipped_with_a_reason() {
    let extracted = extract_readme_h1_commands();
    assert_eq!(
        extracted, EXPECTED,
        "README h1 examples changed; reclassify them in readme_examples.rs"
    );
    assert_eq!(
        RUN_VERBATIM.len() + SKIPPED.len(),
        extracted.len(),
        "run + skipped must account for every extracted command"
    );
    for command in &extracted {
        let runs = RUN_VERBATIM.contains(&command.as_str());
        let skips: Vec<&(&str, &str)> = SKIPPED
            .iter()
            .filter(|(skip, _)| *skip == command)
            .collect();
        assert!(
            runs ^ (skips.len() == 1),
            "{command} must be run verbatim xor skipped exactly once"
        );
        for (_, reason) in skips {
            assert!(reason.len() > 10, "{command} needs a real skip reason");
        }
    }
}

#[test]
fn readme_help_variants_and_list_run_clean_on_an_empty_private_dir() {
    let dir = tempfile::tempdir().unwrap();
    assert_success(dir.path(), &["--help"]);
    for subcommand in HELP_SUBCOMMANDS {
        assert_success(dir.path(), &[subcommand, "--help"]);
    }
    // The one extracted command that is safe verbatim: `h1 list` on an empty private H1_DIR.
    let list = assert_success(dir.path(), &["list"]);
    assert!(
        String::from_utf8_lossy(&list.stdout).contains("no sessions"),
        "list on an empty dir should say so: {}",
        String::from_utf8_lossy(&list.stdout)
    );
}

#[cfg(unix)]
#[test]
fn readme_named_session_lifecycle_on_a_disposable_cat_lab() {
    let dir = Path::new(LIFECYCLE_DIR);
    let cleanup = |dir: &Path| {
        let _ = run_in(dir, &["stop", "-n", LIFECYCLE_NAME]);
        let _ = fs::remove_dir_all(dir);
    };
    cleanup(dir);
    fs::create_dir_all(dir).unwrap();

    let steps = (|| -> Result<(), String> {
        let fail = |args: &[&str], output: &Output| {
            Err(format!(
                "{args:?} failed: {}",
                String::from_utf8_lossy(&output.stderr)
            ))
        };
        let open = &["open", "--detached", "-n", LIFECYCLE_NAME, "--", "cat"];
        let output = run_in(dir, open);
        if !output.status.success() {
            return fail(open, &output);
        }
        wait_until(|| {
            run_in(dir, &["status", "-n", LIFECYCLE_NAME])
                .status
                .success()
        });

        let send = &["send", "-n", LIFECYCLE_NAME, "-e", "hello-readme"];
        let output = run_in(dir, send);
        if !output.status.success() {
            return fail(send, &output);
        }
        // `cat` echoes the line back; wait until it is on screen, then exercise the
        // README's screen / status / list forms against this lab.
        wait_until(|| {
            let screen = run_in(dir, &["screen", "-n", LIFECYCLE_NAME]);
            screen.status.success()
                && String::from_utf8_lossy(&screen.stdout).contains("hello-readme")
        });
        for args in [
            &["screen", "-n", LIFECYCLE_NAME, "--tail", "12", "--compact"][..],
            &["status", "-n", LIFECYCLE_NAME, "--json"][..],
            &["list"][..],
        ] {
            let output = run_in(dir, args);
            if !output.status.success() {
                return fail(args, &output);
            }
            if args[0] == "list"
                && !String::from_utf8_lossy(&output.stdout).contains(LIFECYCLE_NAME)
            {
                return Err("list does not show the cat lab".to_string());
            }
        }
        let stop = &["stop", "-n", LIFECYCLE_NAME];
        let output = run_in(dir, stop);
        if !output.status.success() {
            return fail(stop, &output);
        }
        Ok(())
    })();

    cleanup(dir);
    assert!(
        !dir.exists(),
        "the lifecycle test must remove {LIFECYCLE_DIR}"
    );
    steps.unwrap();
}

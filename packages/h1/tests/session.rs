//! Spec 007: named sessions, `open`, `list`, `status`, `stop`, `key`, `wait`, `watch` and the extended
//! `send`, `ask` and `screen`, each against a real hosted program.

use std::{
    fs,
    path::Path,
    process::{Child, Command, Output, Stdio},
    thread,
    time::{Duration, Instant},
};

use serde_json::Value;

/// Generous: PowerShell takes seconds to start on a cold CI runner. Only reached when a test fails.
const TIMEOUT: Duration = Duration::from_secs(60);

#[cfg(unix)]
mod os {
    /// Prints `ready`, reads a line, prints `got:<line>`, then waits for one more line.
    pub const TWO_LINES: &[&str] = &[
        "sh",
        "-c",
        "printf ready; IFS= read -r line; printf '\\ngot:%s\\n' \"$line\"; IFS= read -r line",
    ];
    /// Renew fake agent (brief: a shell loop): prints `ready`, answers `/new` with a
    /// `got:/new` banner, then keeps reading lines so the session stays alive.
    pub const RENEW_AGENT: &[&str] = &[
        "sh",
        "-c",
        "printf ready; while IFS= read -r line; do if [ \"$line\" = /new ]; then printf '\\ngot:/new\\n'; fi; done",
    ];
    /// Asks a yes/no question, reads a line and prints `answer:<line>`.
    pub const PROMPT: &[&str] = &[
        "sh",
        "-c",
        "printf 'Continue? (y/n) '; IFS= read -r line; printf '\\nanswer:%s\\n' \"$line\"; IFS= read -r line",
    ];
    /// Prints the value of VV_TEST and the working directory.
    pub const ENVIRONMENT: &[&str] = &[
        "sh",
        "-c",
        "printf 'env=%s dir=%s\\n' \"$VV_TEST\" \"$(basename \"$(pwd)\")\"; IFS= read -r line",
    ];
}

#[cfg(windows)]
mod os {
    pub const TWO_LINES: &[&str] = &[
        "powershell",
        "-NoProfile",
        "-Command",
        "[Console]::Write('ready'); $l = [Console]::ReadLine(); [Console]::WriteLine(''); [Console]::WriteLine('got:' + $l); [void][Console]::ReadLine()",
    ];
    pub const RENEW_AGENT: &[&str] = &[
        "powershell",
        "-NoProfile",
        "-Command",
        "[Console]::Write('ready'); while (($l = [Console]::ReadLine()) -ne $null) { if ($l -eq '/new') { [Console]::WriteLine(''); [Console]::WriteLine('got:/new') } }",
    ];
    pub const PROMPT: &[&str] = &[
        "powershell",
        "-NoProfile",
        "-Command",
        "[Console]::Write('Continue? (y/n) '); $l = [Console]::ReadLine(); [Console]::WriteLine(''); [Console]::WriteLine('answer:' + $l); [void][Console]::ReadLine()",
    ];
    pub const ENVIRONMENT: &[&str] = &[
        "powershell",
        "-NoProfile",
        "-Command",
        "[Console]::WriteLine('env=' + $env:VV_TEST + ' dir=' + (Split-Path -Leaf (Get-Location))); [void][Console]::ReadLine()",
    ];
}

fn binary() -> &'static str {
    env!("CARGO_BIN_EXE_h1")
}

fn wait_until(mut condition: impl FnMut() -> bool) {
    let start = Instant::now();
    while !condition() {
        assert!(start.elapsed() < TIMEOUT, "condition timed out");
        thread::sleep(Duration::from_millis(30));
    }
}

/// An isolated session directory and the hosts started in it. Everything is killed when dropped.
struct Lab {
    directory: tempfile::TempDir,
    hosts: Vec<Child>,
}

impl Lab {
    fn new() -> Self {
        Self {
            directory: tempfile::tempdir().unwrap(),
            hosts: Vec::new(),
        }
    }

    fn command(&self, args: &[&str]) -> Command {
        let mut command = Command::new(binary());
        command
            .env("H1_DIR", self.directory.path())
            .env_remove("H1_SOCKET")
            .env_remove("H1_NAME");
        command.args(args);
        command
    }

    fn cli(&self, args: &[&str]) -> Output {
        self.command(args).stdin(Stdio::null()).output().unwrap()
    }

    fn host(&mut self, name: &str, extra: &[&str], program: &[&str]) {
        let mut command = self.command(&["host", "--name", name, "--cols", "60", "--rows", "10"]);
        command
            .args(extra)
            .arg("--")
            .args(program)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        self.hosts.push(command.spawn().expect("host should start"));
        wait_until(|| self.cli(&["status", "-n", name]).status.success());
    }

    fn json(&self, args: &[&str]) -> Value {
        let output = self.cli(args);
        assert!(
            output.status.success(),
            "{args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        serde_json::from_slice(&output.stdout).unwrap_or_else(|error| {
            panic!(
                "{args:?}: {error}: {}",
                String::from_utf8_lossy(&output.stdout)
            )
        })
    }
}

impl Drop for Lab {
    fn drop(&mut self) {
        for host in &mut self.hosts {
            let _ = host.kill();
            let _ = host.wait();
        }
    }
}

fn text(output: &Output) -> String {
    String::from_utf8_lossy(&output.stdout).into_owned()
}

#[test]
fn a_named_session_is_listed_reachable_and_stopped() {
    let mut lab = Lab::new();
    lab.host("alpha", &[], os::TWO_LINES);

    let listed = lab.json(&["list", "--json"]);
    let entries = listed.as_array().unwrap();
    assert_eq!(entries.len(), 1, "{listed}");
    assert_eq!(entries[0]["name"], "alpha");
    assert_eq!(entries[0]["cols"], 60);
    assert!(entries[0]["pid"].as_u64().unwrap() > 0);

    let answer = lab.cli(&["ask", "-n", "alpha", "hello"]);
    assert!(
        answer.status.success(),
        "{}",
        String::from_utf8_lossy(&answer.stderr)
    );
    assert!(text(&answer).contains("got:hello"), "{}", text(&answer));

    let stopped = lab.cli(&["stop", "-n", "alpha"]);
    assert!(
        stopped.status.success(),
        "{}",
        String::from_utf8_lossy(&stopped.stderr)
    );
    wait_until(|| lab.json(&["list", "--json"]).as_array().unwrap().is_empty());
    assert!(
        !lab.cli(&["status", "-n", "alpha"]).status.success(),
        "the session is gone"
    );
}

#[test]
fn wait_matches_a_pattern_and_times_out_with_124() {
    let mut lab = Lab::new();
    lab.host("w", &[], os::TWO_LINES);

    let found = lab.cli(&["wait", "-n", "w", "--for", "rea+dy", "--tail", "3"]);
    assert!(found.status.success());
    assert!(text(&found).contains("ready"));

    let missing = lab.cli(&[
        "wait",
        "-n",
        "w",
        "--for",
        "never-on-screen",
        "-t",
        "1",
        "--quiet",
    ]);
    assert_eq!(missing.status.code(), Some(124));
    assert!(missing.stdout.is_empty(), "--quiet prints nothing");

    let nothing = lab.cli(&["wait", "-n", "w"]);
    assert!(
        !nothing.status.success(),
        "a wait without a condition is an error"
    );
    assert!(String::from_utf8_lossy(&nothing.stderr).contains("needs a condition"));
}

#[test]
fn a_dialog_is_detected_and_answered_with_named_keys() {
    let mut lab = Lab::new();
    lab.host("p", &[], os::PROMPT);

    let asking = lab.cli(&["wait", "-n", "p", "--asking", "-t", "30"]);
    assert!(
        asking.status.success(),
        "{}",
        String::from_utf8_lossy(&asking.stderr)
    );
    assert!(text(&asking).contains("(y/n)"));
    assert_eq!(
        lab.json(&["status", "-n", "p", "--json"])["state"],
        "asking"
    );

    assert!(lab.cli(&["key", "-n", "p", "y", "Enter"]).status.success());
    let answered = lab.cli(&["wait", "-n", "p", "--for", "answer:y", "-t", "30"]);
    assert!(answered.status.success(), "{}", text(&answered));
}

#[test]
fn status_tells_working_from_stalled_and_reports_the_host() {
    let mut lab = Lab::new();
    lab.host("s", &[], os::TWO_LINES);
    assert!(
        lab.cli(&["wait", "-n", "s", "--for", "ready", "-q"])
            .status
            .success()
    );
    thread::sleep(Duration::from_millis(700));

    let status = lab.json(&["status", "-n", "s", "--json", "--stalled-ms", "300"]);
    assert_eq!(status["state"], "stalled", "{status}");
    assert_eq!(status["running"], true);
    assert_eq!(
        (status["cols"].as_u64(), status["rows"].as_u64()),
        (Some(60), Some(10))
    );
    assert_eq!(status["name"], "s");
    assert!(status["quiet_ms"].as_u64().unwrap() >= 300);

    let busy = lab.json(&["status", "-n", "s", "--json", "--stalled-ms", "3600000"]);
    assert_eq!(
        busy["state"], "working",
        "a long stall limit keeps it working: {busy}"
    );

    let plain = lab.cli(&["status", "-n", "s"]);
    assert!(text(&plain).contains("state:"), "{}", text(&plain));
}

#[test]
fn watch_reports_a_stall_once_and_exits() {
    let mut lab = Lab::new();
    lab.host("w2", &[], os::TWO_LINES);
    let output = lab.cli(&[
        "watch",
        "-n",
        "w2",
        "--once",
        "--only",
        "stalled",
        "--stalled-ms",
        "400",
        "--interval-ms",
        "100",
        "--json",
    ]);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let event: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(event["state"], "stalled");
    assert!(event["screen_tail"].as_str().unwrap().contains("ready"));
}

#[test]
fn screen_can_be_trimmed_and_read_as_json() {
    let mut lab = Lab::new();
    lab.host("j", &[], os::TWO_LINES);
    assert!(
        lab.cli(&["wait", "-n", "j", "--for", "ready", "-q"])
            .status
            .success()
    );

    let json = lab.json(&["screen", "-n", "j", "--json", "--spans"]);
    assert_eq!(json["rows"], 10);
    assert_eq!(json["cols"], 60);
    assert_eq!(json["lines"].as_array().unwrap().len(), 10);
    assert!(json["lines"][0].as_str().unwrap().contains("ready"));
    assert!(json["cursor"].is_array());
    assert!(json["spans"].is_array());

    let tail = lab.cli(&["screen", "-n", "j", "--tail", "1"]);
    assert_eq!(
        text(&tail).trim(),
        text(&tail).trim_end(),
        "no trailing spaces"
    );
    assert!(text(&tail).contains("ready"));
    assert_eq!(text(&tail).trim_end().lines().count(), 1);

    let compact = lab.cli(&["screen", "-n", "j", "--compact"]);
    assert!(
        !text(&compact).lines().any(|line| line.trim().is_empty()),
        "{}",
        text(&compact)
    );
}

#[test]
fn paced_typing_and_a_text_file_reach_the_program_intact() {
    let mut lab = Lab::new();
    lab.host("t", &[], os::TWO_LINES);
    let paced = lab.cli(&[
        "ask",
        "-n",
        "t",
        "--paced",
        "--chunk",
        "3",
        "--pause-ms",
        "10",
        "--enter-delay-ms",
        "10",
        "ünïcode text",
    ]);
    assert!(
        paced.status.success(),
        "{}",
        String::from_utf8_lossy(&paced.stderr)
    );
    assert!(
        text(&paced).contains("got:ünïcode text"),
        "no character split in the middle: {}",
        text(&paced)
    );

    let mut lab = Lab::new();
    lab.host("f", &[], os::TWO_LINES);
    let file = lab.directory.path().join("brief.txt");
    fs::write(&file, "from a file\n").unwrap();
    let asked = lab.cli(&["ask", "-n", "f", "--file", file.to_str().unwrap()]);
    assert!(text(&asked).contains("got:from a file"), "{}", text(&asked));
}

#[test]
fn ask_exits_124_when_the_pattern_never_shows() {
    let mut lab = Lab::new();
    lab.host("a", &[], os::TWO_LINES);
    let output = lab.cli(&[
        "ask",
        "-n",
        "a",
        "--until",
        "this never appears",
        "-t",
        "1",
        "--tail",
        "2",
    ]);
    assert_eq!(output.status.code(), Some(124));
    assert!(String::from_utf8_lossy(&output.stderr).contains("timed out"));
}

#[test]
fn cwd_and_env_reach_the_hosted_program() {
    let mut lab = Lab::new();
    let work = lab.directory.path().join("workdir");
    fs::create_dir(&work).unwrap();
    lab.host(
        "e",
        &["--env", "VV_TEST=marker", "--cwd", work.to_str().unwrap()],
        os::ENVIRONMENT,
    );
    let seen = lab.cli(&[
        "wait",
        "-n",
        "e",
        "--for",
        "env=marker dir=workdir",
        "-t",
        "30",
    ]);
    assert!(seen.status.success(), "{}", text(&seen));
}

#[test]
fn open_detached_names_a_session_that_list_and_stop_can_reach() {
    let lab = Lab::new();
    let mut arguments = vec![
        "open",
        "--detached",
        "-n",
        "beta",
        "-C",
        "70",
        "-R",
        "12",
        "--",
    ];
    arguments.extend_from_slice(os::TWO_LINES);
    let opened = lab.cli(&arguments);
    assert!(
        opened.status.success(),
        "{}",
        String::from_utf8_lossy(&opened.stderr)
    );
    assert!(text(&opened).contains("opened beta"), "{}", text(&opened));

    let status = lab.json(&["status", "-n", "beta", "--json"]);
    assert_eq!(
        (status["cols"].as_u64(), status["rows"].as_u64()),
        (Some(70), Some(12))
    );
    assert_eq!(lab.json(&["list", "--json"])[0]["name"], "beta");

    let mut again = vec!["open", "--detached", "-n", "beta", "--"];
    again.extend_from_slice(os::TWO_LINES);
    let refused = lab.cli(&again);
    assert!(
        !refused.status.success(),
        "a second open with the same name is refused"
    );
    assert!(String::from_utf8_lossy(&refused.stderr).contains("already running"));

    assert!(lab.cli(&["stop", "-n", "beta"]).status.success());
    wait_until(|| lab.json(&["list", "--json"]).as_array().unwrap().is_empty());
}

#[test]
fn bad_names_and_missing_sessions_fail_clearly() {
    let lab = Lab::new();
    let bad = lab.cli(&["status", "-n", "../escape"]);
    assert!(!bad.status.success());
    assert!(String::from_utf8_lossy(&bad.stderr).contains("invalid session name"));

    let missing = lab.cli(&["stop", "-n", "nobody"]);
    assert!(!missing.status.success());
    assert!(
        String::from_utf8_lossy(&missing.stderr).contains("no session answers"),
        "{}",
        String::from_utf8_lossy(&missing.stderr)
    );

    let clash = lab.cli(&["send", "-s", "/tmp/x.sock", "-n", "both", "text"]);
    assert!(!clash.status.success(), "-s and -n cannot be combined");
}

#[test]
fn a_stale_registry_entry_is_pruned_by_list() {
    let lab = Lab::new();
    let stale = serde_json::json!({
        "name": "ghost", "pid": 1, "socket": lab.directory.path().join("ghost.sock").display().to_string(),
        "command": ["nothing"], "cols": 80, "rows": 24, "started_ms": 1,
    });
    fs::write(lab.directory.path().join("ghost.json"), stale.to_string()).unwrap();
    let shown = lab.json(&["list", "--json", "--all"]);
    assert_eq!(shown[0]["name"], "ghost");
    assert_eq!(shown[0]["state"], "dead");
    let pruned = lab.json(&["list", "--json"]);
    assert!(pruned.as_array().unwrap().is_empty(), "{pruned}");
    assert!(
        !Path::new(&lab.directory.path().join("ghost.json")).exists(),
        "the dead entry is removed"
    );
}

#[test]
fn renew_sends_new_cmd_then_resume_prompt_with_last_5_log_lines_and_brief() {
    let mut lab = Lab::new();
    let dir = lab.directory.path().to_path_buf();
    let log = dir.join("resume.log");
    fs::write(
        &log,
        "old-1\nold-2\nkeep-1\nkeep-2\nkeep-3\nkeep-4\nkeep-5\n",
    )
    .unwrap();
    let brief = dir.join("brief.txt");
    fs::write(&brief, "brief-content-xyz\n").unwrap();
    lab.host(
        "r",
        &[
            "--brief",
            brief.to_str().unwrap(),
            "--resume-log",
            log.to_str().unwrap(),
            "--new-cmd",
            "/new",
            "--ready-regex",
            "got:/new",
        ],
        os::RENEW_AGENT,
    );
    let out = lab.cli(&["renew", "-n", "r", "-t", "30"]);
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert_eq!(
        text(&out).trim(),
        "renewed r (rearm confirmed)",
        "{}",
        text(&out)
    );
    let prompt = lab.cli(&[
        "wait",
        "-n",
        "r",
        "--for",
        "You were renewed. Resume from your last checkpoint:",
        "-t",
        "5",
    ]);
    assert!(prompt.status.success(), "{}", text(&prompt));
    let brief_seen = lab.cli(&["wait", "-n", "r", "--for", "brief-content-xyz", "-t", "5"]);
    assert!(brief_seen.status.success(), "{}", text(&brief_seen));
    let last = lab.cli(&["wait", "-n", "r", "--for", "keep-5", "-t", "5"]);
    assert!(last.status.success(), "{}", text(&last));
    let screen = lab.cli(&["wait", "-n", "r", "--for", "keep-1", "-t", "5"]);
    assert!(screen.status.success(), "{}", text(&screen));
}

#[test]
fn renew_defaults_new_cmd_and_fails_clearly_for_missing_or_unready_sessions() {
    let lab = Lab::new();
    let missing = lab.cli(&["renew", "-n", "nobody", "-t", "5"]);
    assert!(!missing.status.success());
    assert!(!String::from_utf8_lossy(&missing.stderr).trim().is_empty());
    let mut lab2 = Lab::new();
    lab2.host("u", &["--ready-regex", "this never appears"], os::TWO_LINES);
    let out = lab2.cli(&["renew", "-n", "u", "-t", "1"]);
    assert!(
        !out.status.success(),
        "unready renew must fail: {}",
        text(&out)
    );
    assert_eq!(
        String::from_utf8_lossy(&out.stderr)
            .lines()
            .filter(|l| !l.trim().is_empty())
            .count(),
        1,
        "one-line reason: {}",
        String::from_utf8_lossy(&out.stderr)
    );
}

/// Fake agent that answers `/new` with `got:/new`, appends every later line it
/// receives to `record` (one line per submission) and prints `ack-line` for each,
/// so a correct rearm is confirmed. Returns the program argv running the script.
#[cfg(unix)]
fn renew_recording_agent(dir: &Path, record: &Path) -> Vec<String> {
    let script = dir.join("record-agent.sh");
    fs::write(
        &script,
        format!(
            "printf ready; while IFS= read -r line; do if [ \"$line\" = /new ]; then echo; echo 'got:/new'; continue; fi; echo \"$line\" >> '{}'; echo; echo 'ack-line'; done",
            record.display()
        ),
    )
    .unwrap();
    vec!["sh".to_owned(), script.to_str().unwrap().to_owned()]
}

#[cfg(windows)]
fn renew_recording_agent(dir: &Path, record: &Path) -> Vec<String> {
    let script = dir.join("record-agent.ps1");
    fs::write(
        &script,
        format!(
            "[Console]::Write('ready'); while (($l = [Console]::ReadLine()) -ne $null) {{ if ($l -eq '/new') {{ [Console]::WriteLine(''); [Console]::WriteLine('got:/new'); continue }}; Add-Content -Path '{}' -Value $l; [Console]::WriteLine(''); [Console]::WriteLine('ack-line') }}",
            record.display()
        ),
    )
    .unwrap();
    vec![
        "powershell".to_owned(),
        "-NoProfile".to_owned(),
        "-File".to_owned(),
        script.to_str().unwrap().to_owned(),
    ]
}

/// Fake agent that answers `/new` with `got:/new` but never reacts to the resume
/// prompt: terminal echo is off and it prints nothing for other lines, so the
/// screen never changes after the prompt and rearm stays unconfirmed.
#[cfg(unix)]
fn renew_silent_agent(dir: &Path) -> Vec<String> {
    let script = dir.join("silent-agent.sh");
    fs::write(
        &script,
        "printf ready; stty -echo; while IFS= read -r line; do if [ \"$line\" = /new ]; then echo; echo 'got:/new'; fi; done",
    )
    .unwrap();
    vec!["sh".to_owned(), script.to_str().unwrap().to_owned()]
}

#[cfg(windows)]
fn renew_silent_agent(dir: &Path) -> Vec<String> {
    let script = dir.join("silent-agent.ps1");
    fs::write(
        &script,
        "[Console]::Write('ready'); while (($l = [Console]::ReadLine()) -ne $null) { if ($l -eq '/new') { [Console]::WriteLine(''); [Console]::WriteLine('got:/new') } }",
    )
    .unwrap();
    vec![
        "powershell".to_owned(),
        "-NoProfile".to_owned(),
        "-File".to_owned(),
        script.to_str().unwrap().to_owned(),
    ]
}

#[test]
fn renew_rearm_is_one_single_line_submission_after_new() {
    let mut lab = Lab::new();
    let dir = lab.directory.path().to_path_buf();
    let log = dir.join("resume.log");
    fs::write(
        &log,
        "old-1\nold-2\nkeep-1\nkeep-2\nkeep-3\nkeep-4\nkeep-5\n",
    )
    .unwrap();
    let brief = dir.join("brief.txt");
    fs::write(&brief, "brief-content-xyz\n").unwrap();
    let record = dir.join("submissions.txt");
    let program = renew_recording_agent(&dir, &record);
    let program_refs: Vec<&str> = program.iter().map(String::as_str).collect();
    lab.host(
        "r",
        &[
            "--brief",
            brief.to_str().unwrap(),
            "--resume-log",
            log.to_str().unwrap(),
            "--new-cmd",
            "/new",
            "--ready-regex",
            "got:/new",
        ],
        &program_refs,
    );
    let out = lab.cli(&["renew", "-n", "r", "-t", "30"]);
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    wait_until(|| {
        fs::read_to_string(&record)
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false)
    });
    // Give any extra (buggy) submissions a moment to land, then count.
    thread::sleep(Duration::from_millis(500));
    let recorded = fs::read_to_string(&record).unwrap();
    let lines: Vec<&str> = recorded.lines().collect();
    assert_eq!(
        lines.len(),
        1,
        "exactly one submission after /new: {recorded:?}"
    );
    assert_eq!(
        lines[0],
        "You were renewed. Resume from your last checkpoint: keep-1 keep-2 keep-3 keep-4 keep-5 brief-content-xyz",
        "header, log tail and brief together on the single submitted line"
    );
}

/// Opens a recording lab with `extra` flags and a brief and resume log; returns (record path, lab).
fn autorearm_lab(extra: &[&str]) -> (Lab, std::path::PathBuf) {
    let lab = Lab::new();
    let dir = lab.directory.path().to_path_buf();
    let log = dir.join("resume.log");
    fs::write(&log, "keep-1\nkeep-2\n").unwrap();
    let brief = dir.join("brief.txt");
    fs::write(&brief, "brief-content-xyz\n").unwrap();
    let record = dir.join("submissions.txt");
    let program = renew_recording_agent(&dir, &record);
    let program_refs: Vec<&str> = program.iter().map(String::as_str).collect();
    let mut flags = vec![
        "--brief",
        brief.to_str().unwrap(),
        "--resume-log",
        log.to_str().unwrap(),
        "--new-cmd",
        "/new",
        "--ready-regex",
        "got:/new",
    ];
    flags.extend_from_slice(extra);
    let mut lab = lab;
    lab.host("r", &flags, &program_refs);
    (lab, record)
}

#[test]
fn autorearm_submitted_new_cmd_triggers_exactly_one_rearm() {
    let (lab, record) = autorearm_lab(&["--auto-rearm"]);
    let out = lab.cli(&["send", "-n", "r", "/new", "-e"]);
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    wait_until(|| {
        fs::read_to_string(&record)
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false)
    });
    thread::sleep(Duration::from_millis(1500));
    let recorded = fs::read_to_string(&record).unwrap();
    let lines: Vec<&str> = recorded.lines().collect();
    assert_eq!(
        lines.len(),
        1,
        "exactly one re-arm submission: {recorded:?}"
    );
    assert_eq!(
        lines[0],
        "You were renewed. Resume from your last checkpoint: keep-1 keep-2 brief-content-xyz"
    );
}

#[test]
fn autorearm_ignores_text_that_only_contains_the_command() {
    let (lab, record) = autorearm_lab(&["--auto-rearm"]);
    for text in ["please do not run /new yet", "/newer", "x/new"] {
        let out = lab.cli(&["send", "-n", "r", text, "-e"]);
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
    }
    wait_until(|| {
        fs::read_to_string(&record)
            .map(|s| s.lines().count() >= 3)
            .unwrap_or(false)
    });
    thread::sleep(Duration::from_millis(2500));
    let recorded = fs::read_to_string(&record).unwrap();
    assert_eq!(
        recorded.lines().collect::<Vec<_>>(),
        ["please do not run /new yet", "/newer", "x/new"],
        "only the typed lines, no re-arm: {recorded:?}"
    );
}

#[test]
fn autorearm_is_off_unless_asked_for() {
    let (lab, record) = autorearm_lab(&[]);
    let out = lab.cli(&["send", "-n", "r", "/new", "-e"]);
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    wait_until(|| {
        let screen = lab.cli(&["screen", "-n", "r"]);
        String::from_utf8_lossy(&screen.stdout).contains("got:/new")
    });
    thread::sleep(Duration::from_millis(3000));
    let recorded = fs::read_to_string(&record).unwrap_or_default();
    assert!(
        recorded.trim().is_empty(),
        "no re-arm without --auto-rearm: {recorded:?}"
    );
}

#[test]
fn renew_unconfirmed_rearm_exits_1() {
    let mut lab = Lab::new();
    let dir = lab.directory.path().to_path_buf();
    let program = renew_silent_agent(&dir);
    let program_refs: Vec<&str> = program.iter().map(String::as_str).collect();
    lab.host("s", &["--ready-regex", "got:/new"], &program_refs);
    let out = lab.cli(&["renew", "-n", "s", "-t", "5"]);
    assert_eq!(
        out.status.code(),
        Some(1),
        "unconfirmed rearm must exit 1: {} {}",
        text(&out),
        String::from_utf8_lossy(&out.stderr)
    );
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert_eq!(
        stderr.lines().filter(|l| !l.trim().is_empty()).count(),
        1,
        "one-line reason: {stderr}"
    );
    assert!(stderr.contains("did not confirm rearm"), "{stderr}");
}

fn kill_only_host(lab: &mut Lab) {
    lab.hosts[0].kill().unwrap();
    lab.hosts[0].wait().unwrap();
    thread::sleep(Duration::from_millis(200));
}

#[test]
fn recover_killed_fake_agent_resends_brief() {
    let mut lab = Lab::new();
    let dir = lab.directory.path().to_path_buf();
    let log = dir.join("resume.log");
    fs::write(&log, "old-1\nold-2\nkeep-1\nkeep-2\nkeep-3\nkeep-4\nkeep-5\n").unwrap();
    let brief = dir.join("brief.txt");
    fs::write(&brief, "brief-content-xyz\n").unwrap();
    let record = dir.join("submissions.txt");
    let program = renew_recording_agent(&dir, &record);
    let program_refs: Vec<&str> = program.iter().map(String::as_str).collect();
    lab.host(
        "k",
        &[
            "--brief",
            brief.to_str().unwrap(),
            "--resume-log",
            log.to_str().unwrap(),
            "--new-cmd",
            "/new",
            "--ready-regex",
            "got:/new",
        ],
        &program_refs,
    );
    kill_only_host(&mut lab);
    let out = lab.cli(&["recover", "-n", "k", "-t", "30"]);
    assert!(
        out.status.success(),
        "recover: {} {}",
        text(&out),
        String::from_utf8_lossy(&out.stderr)
    );
    wait_until(|| {
        fs::read_to_string(&record)
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false)
    });
    thread::sleep(Duration::from_millis(500));
    let recorded = fs::read_to_string(&record).unwrap();
    let lines: Vec<&str> = recorded.lines().collect();
    assert_eq!(lines.len(), 1, "brief re-sent exactly once: {recorded:?}");
    assert_eq!(
        lines[0],
        "You were renewed. Resume from your last checkpoint: keep-1 keep-2 keep-3 keep-4 keep-5 brief-content-xyz"
    );
    assert!(lab.cli(&["status", "-n", "k"]).status.success());
    assert!(lab.cli(&["stop", "-n", "k"]).status.success());
}

#[test]
fn recover_missing_env_name_reports_name_only() {
    let mut lab = Lab::new();
    lab.host(
        "m",
        &["--env", "R42_ONLY_NAME=original-secret-value"],
        os::TWO_LINES,
    );
    kill_only_host(&mut lab);
    let mut cmd = lab.command(&["recover", "-n", "m", "-t", "5"]);
    cmd.env_remove("R42_ONLY_NAME");
    let out = cmd.output().unwrap();
    assert!(!out.status.success(), "missing env name must fail recover");
    let combined = format!(
        "{} {}",
        text(&out),
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(
        combined.contains("R42_ONLY_NAME"),
        "missing name reported by name: {combined}"
    );
    assert!(
        !combined.contains("original-secret-value"),
        "env value must never be reported: {combined}"
    );
    assert!(
        !lab.cli(&["status", "-n", "m"]).status.success(),
        "session must not be reopened"
    );
}

#[test]
fn recover_live_session_refused() {
    let mut lab = Lab::new();
    lab.host("live", &[], os::TWO_LINES);
    let out = lab.cli(&["recover", "-n", "live", "-t", "5"]);
    assert!(!out.status.success(), "live session must be refused");
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(stderr.contains("running"), "refusal says running: {stderr}");
    assert!(
        lab.cli(&["status", "-n", "live"]).status.success(),
        "live session untouched"
    );
}

#[test]
fn doctor_lists_record_but_no_host() {
    let mut lab = Lab::new();
    lab.host("deadlab", &[], os::TWO_LINES);
    kill_only_host(&mut lab);
    let out = lab.cli(&["doctor"]);
    let combined = format!(
        "{} {}",
        text(&out),
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(
        combined.contains("deadlab"),
        "doctor lists the dead session: {combined}"
    );
    assert!(
        combined.contains("recover"),
        "doctor says h1 recover would fix it: {combined}"
    );
}

#[test]
fn renew_long_brief_becomes_pointer_line() {
    let mut lab = Lab::new();
    let dir = lab.directory.path().to_path_buf();
    let brief = dir.join("big-brief.txt");
    let mut body = String::from("UNIQUE-LONG-BRIEF-MARKER");
    body.push_str(&" x".repeat(1100));
    fs::write(&brief, &body).unwrap();
    assert!(body.trim().chars().count() > 2000);
    let record = dir.join("submissions.txt");
    let program = renew_recording_agent(&dir, &record);
    let program_refs: Vec<&str> = program.iter().map(String::as_str).collect();
    lab.host(
        "p",
        &[
            "--brief",
            brief.to_str().unwrap(),
            "--new-cmd",
            "/new",
            "--ready-regex",
            "got:/new",
        ],
        &program_refs,
    );
    let out = lab.cli(&["renew", "-n", "p", "-t", "30"]);
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    wait_until(|| {
        fs::read_to_string(&record)
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false)
    });
    thread::sleep(Duration::from_millis(500));
    let recorded = fs::read_to_string(&record).unwrap();
    let lines: Vec<&str> = recorded.lines().collect();
    assert_eq!(
        lines.len(),
        1,
        "exactly one submission after /new: {recorded:?}"
    );
    let pointer = format!("read {} and continue", brief.to_str().unwrap());
    assert!(
        lines[0].contains(&pointer),
        "single line carries the pointer {pointer:?}: {:?}",
        lines[0]
    );
    assert!(
        !lines[0].contains("UNIQUE-LONG-BRIEF-MARKER"),
        "brief body must not be inlined: {:?}",
        lines[0]
    );
    assert_eq!(
        lines[0],
        format!("You were renewed. Resume from your last checkpoint: {pointer}")
    );
}

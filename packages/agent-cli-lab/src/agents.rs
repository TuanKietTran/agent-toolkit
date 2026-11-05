//! `agent-cli-lab agents`: find every AI agent instance running on this machine, not only the
//! labs this tool hosts.
//!
//! Sources, all read-only:
//! - the process table (`ps`): every agent program (Claude Code, Pi, opencode, and the other harnesses in the rule table below)
//!   and every lab host. A lab host's command line carries the lab's name, role, parent and model,
//!   for both the current and the older `host -s NAME` form; the agent it hosts is its child process.
//! - `~/.claude/sessions/<pid>.json`: Claude Code's own record of each running session (session id,
//!   status busy/idle/shell, working directory). This is how the user's own interactive session is
//!   found, exactly, without guessing from transcripts.
//! - Claude transcripts (`~/.claude/projects/*/<session id>.jsonl`): only the tail, for the model,
//!   the token count and a short redacted last-message snippet.
//! - for labs, the host's own screen: state (working/asking/stalled) and a Pi context footer.
//!
//! Discovery (`build`) is a pure function of its inputs so it is tested without a machine; the
//! thin I/O around it lives in `scan`.

use std::collections::{HashMap, HashSet};
use std::io::{Read, Seek, SeekFrom};
use std::sync::OnceLock;

use regex::Regex;
use serde::{Deserialize, Serialize};

use super::*;
use commands::{human_duration, request_with_timeout};

/// One agent instance. Every field except `status` may be absent, and consumers must tolerate that.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentRec {
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub role: Option<String>,
    #[serde(default)]
    pub parent: Option<String>,
    #[serde(default)]
    pub pid: Option<u64>,
    #[serde(default)]
    pub host_pid: Option<u64>,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub context: Option<String>,
    #[serde(default)]
    pub uptime: Option<String>,
    #[serde(default)]
    pub last: Option<String>,
    #[serde(default)]
    pub tty: Option<String>,
    #[serde(default)]
    pub session_id: Option<String>,
    /// Where the record came from: `lab`, `claude-session`, `process`.
    #[serde(default)]
    pub source: Option<String>,
    /// Hosted by agent-cli-lab (a lab) rather than started by a person.
    #[serde(default)]
    pub managed: bool,
    /// The session that ran this scan (an ancestor of this process, or named by $CLAUDE_CODE_SESSION_ID).
    #[serde(default)]
    pub this_session: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Registry {
    #[serde(default)]
    pub generated_at: Option<String>,
    #[serde(default)]
    pub agents: Vec<AgentRec>,
}

// ------------------------------------------------------------------ the process table

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Proc {
    pub pid: u32,
    pub ppid: u32,
    pub age_secs: u64,
    pub cpu: f32,
    pub tty: Option<String>,
    pub command: String,
}

/// `[[dd-]hh:]mm:ss` as printed by `ps -o etime`.
pub(crate) fn parse_etime(text: &str) -> Option<u64> {
    let (days, rest) = match text.split_once('-') {
        Some((days, rest)) => (days.parse::<u64>().ok()?, rest),
        None => (0, text),
    };
    let numbers: Option<Vec<u64>> = rest.split(':').map(|part| part.parse().ok()).collect();
    let seconds = match numbers?.as_slice() {
        [m, s] => m * 60 + s,
        [h, m, s] => h * 3600 + m * 60 + s,
        _ => return None,
    };
    Some(days * 86_400 + seconds)
}

/// Lines of `ps -axww -o pid=,ppid=,etime=,pcpu=,command=`.
pub(crate) fn parse_ps(text: &str) -> Vec<Proc> {
    text.lines()
        .filter_map(|line| {
            let mut rest = line.trim_start();
            let mut fields = [""; 4];
            // A fifth field is the tty when the ps output carries one (`ttys001`, `??`, `pts/0`);
            // older callers and test fixtures without it leave the command untouched.
            for field in fields.iter_mut() {
                let (head, tail) = rest.split_once(char::is_whitespace)?;
                *field = head;
                rest = tail.trim_start();
            }
            let (tty, command) = match rest.split_once(char::is_whitespace) {
                Some(("??", tail)) => (None, tail.trim_start()),
                Some((head, tail))
                    if head == "console" || head.starts_with("tty") || head.starts_with("pts/") =>
                {
                    (Some(head.to_owned()), tail.trim_start())
                }
                _ => (None, rest),
            };
            Some(Proc {
                pid: fields[0].parse().ok()?,
                ppid: fields[1].parse().ok()?,
                age_secs: parse_etime(fields[2])?,
                cpu: fields[3].parse().ok()?,
                tty,
                command: command.trim_end().to_owned(),
            })
        })
        .collect()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Program {
    Claude,
    Pi,
    Opencode,
    Codex,
    Gemini,
    Aider,
    CursorAgent,
    Goose,
    Amp,
    Crush,
    Qwen,
    Kimi,
    Droid,
    Copilot,
    Cline,
    Continue,
    Cody,
    LabHost,
}

impl Program {
    fn kind(self) -> &'static str {
        match self {
            Program::Claude => "claude",
            Program::Pi => "pi",
            Program::Opencode => "opencode",
            Program::Codex => "codex",
            Program::Gemini => "gemini",
            Program::Aider => "aider",
            Program::CursorAgent => "cursor-agent",
            Program::Goose => "goose",
            Program::Amp => "amp",
            Program::Crush => "crush",
            Program::Qwen => "qwen",
            Program::Kimi => "kimi",
            Program::Droid => "droid",
            Program::Copilot => "copilot-cli",
            Program::Cline => "cline",
            Program::Continue => "continue",
            Program::Cody => "cody",
            Program::LabHost => "lab",
        }
    }
}

fn basename(word: &str) -> &str {
    word.rsplit('/').next().unwrap_or(word)
}

impl Program {
    fn from_kind(kind: &str) -> Option<Program> {
        Some(match kind {
            "claude" => Program::Claude,
            "pi" => Program::Pi,
            "opencode" => Program::Opencode,
            "codex" => Program::Codex,
            "gemini" => Program::Gemini,
            "aider" => Program::Aider,
            "cursor-agent" => Program::CursorAgent,
            "goose" => Program::Goose,
            "amp" => Program::Amp,
            "crush" => Program::Crush,
            "qwen" => Program::Qwen,
            "kimi" => Program::Kimi,
            "droid" => Program::Droid,
            "copilot-cli" => Program::Copilot,
            "cline" => Program::Cline,
            "continue" => Program::Continue,
            "cody" => Program::Cody,
            "lab" => Program::LabHost,
            _ => return None,
        })
    }
}

// ------------------------------------------------------------------ harness rules
//
// Detection is data-driven. Each rule names one harness `kind` (also its `--kind` filter value):
// `exe_names` are exact argv[0] basenames, `script_keywords` are substrings matched against the
// script argument when argv[0] is an interpreter, `exclude_argv` substrings disqualify a process
// (helpers, MCP servers, version probes), and `weak_exe` kinds are short namesakes (goose, amp,
// crush, droid, cline, cody, cn) whose bare basename only counts from a known install path or
// with a script-keyword hit. `env_keys` document the marker variables that relocate a harness's
// home directory; process environments are not readable for other users' processes on macOS, so
// they are never used as a required signal and their values never appear in output.
//
// Users may add or override rules in `~/.agent-cli-lab/harnesses.toml`, a hand-parsed subset:
// one `[[harness]]` table per rule with `kind = "name"`, string arrays `exe_names`,
// `script_keywords`, `argv_keywords`, `interpreters`, `env_keys`, `exclude_argv`, and
// `weak_exe = true|false`. A user rule with an existing kind replaces that rule's non-empty
// fields; a new kind is appended, so `--kind <name>` accepts it. A missing or malformed file
// is ignored and never breaks scanning.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct HarnessRule {
    pub kind: String,
    pub exe_names: Vec<String>,
    pub script_keywords: Vec<String>,
    #[allow(dead_code)]
    pub argv_keywords: Vec<String>,
    pub interpreters: Vec<String>,
    #[allow(dead_code)]
    pub env_keys: Vec<String>,
    pub exclude_argv: Vec<String>,
    pub weak_exe: bool,
}

fn harness_rule(
    kind: &str,
    exe_names: &[&str],
    script_keywords: &[&str],
    env_keys: &[&str],
    weak_exe: bool,
) -> HarnessRule {
    HarnessRule {
        kind: kind.into(),
        exe_names: exe_names.iter().map(|s| s.to_string()).collect(),
        script_keywords: script_keywords.iter().map(|s| s.to_string()).collect(),
        argv_keywords: Vec::new(),
        interpreters: ["node", "bun", "deno", "python3", "python", "uv"]
            .iter()
            .map(|s| s.to_string())
            .collect(),
        env_keys: env_keys.iter().map(|s| s.to_string()).collect(),
        exclude_argv: ["--version", "--help", "extensionHost", "Code Helper"]
            .iter()
            .map(|s| s.to_string())
            .collect(),
        weak_exe,
    }
}

pub(crate) fn builtin_rules() -> Vec<HarnessRule> {
    let mut claude = harness_rule(
        "claude",
        &["claude"],
        &[
            "@anthropic-ai/claude-code",
            "claude-code/cli.js",
            "claude-code",
        ],
        &["CLAUDE_CONFIG_DIR", "CLAUDECODE"],
        false,
    );
    claude.exclude_argv.extend([
        "--chrome-native-host".to_string(),
        " mcp ".to_string(),
        "mcp-server".to_string(),
    ]);
    vec![
        claude,
        harness_rule(
            "pi",
            &["pi"],
            &["pi-coding-agent", "@earendil-works/pi"],
            &["PI_CODING_AGENT_DIR"],
            false,
        ),
        harness_rule(
            "opencode",
            &["opencode"],
            &["opencode"],
            &["OPENCODE_CONFIG"],
            false,
        ),
        harness_rule(
            "codex",
            &["codex"],
            &["@openai/codex", "codex"],
            &["CODEX_HOME"],
            false,
        ),
        harness_rule(
            "gemini",
            &["gemini"],
            &["gemini-cli", "@google/gemini-cli", "bundle/gemini.js"],
            &["GEMINI_API_KEY"],
            false,
        ),
        harness_rule("aider", &["aider"], &["aider/main.py", "aider"], &[], false),
        harness_rule(
            "cursor-agent",
            &["cursor-agent"],
            &["cursor-agent"],
            &["CURSOR_API_KEY"],
            false,
        ),
        harness_rule("goose", &["goose"], &["goose"], &["GOOSE_MODE"], true),
        harness_rule(
            "amp",
            &["amp"],
            &["@sourcegraph/amp"],
            &["AMP_API_KEY"],
            true,
        ),
        harness_rule(
            "crush",
            &["crush"],
            &["@charmland/crush", "crush"],
            &[],
            true,
        ),
        harness_rule(
            "qwen",
            &["qwen"],
            &["@qwen-code/qwen-code", "qwen-code"],
            &["QWEN_CODE_HOME"],
            false,
        ),
        harness_rule(
            "kimi",
            &["kimi", "kimi-code"],
            &["kimi-code", "@moonshot-ai/kimi-code", "kimi-cli"],
            &["MOONSHOT_API_KEY"],
            false,
        ),
        harness_rule("droid", &["droid"], &["droid"], &["FACTORY_API_KEY"], true),
        harness_rule(
            "copilot-cli",
            &["copilot"],
            &["copilot"],
            &["COPILOT_GITHUB_TOKEN"],
            false,
        ),
        harness_rule("cline", &["cline"], &["@cline/sdk", "cline"], &[], true),
        harness_rule(
            "continue",
            &["cn"],
            &["@continuedev/continue", "continue"],
            &[],
            true,
        ),
        harness_rule(
            "cody",
            &["cody"],
            &["@sourcegraph/cody", "cody"],
            &["SRC_ENDPOINT"],
            true,
        ),
    ]
}

fn parse_string_list(value: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = value;
    while let Some(start) = rest.find('"') {
        let after = &rest[start + 1..];
        let Some(end) = after.find('"') else { break };
        out.push(after[..end].to_string());
        rest = &after[end + 1..];
    }
    out
}

/// Parse the documented `harnesses.toml` subset. Unknown keys and malformed lines are skipped;
/// a rule without a `kind` is dropped.
pub(crate) fn parse_harness_rules(text: &str) -> Vec<HarnessRule> {
    let mut rules: Vec<HarnessRule> = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line == "[[harness]]" {
            rules.push(harness_rule("", &[], &[], &[], false));
            continue;
        }
        let Some(current) = rules.last_mut() else {
            continue;
        };
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let (key, value) = (key.trim(), value.trim());
        match key {
            "kind" => {
                current.kind = parse_string_list(value)
                    .into_iter()
                    .next()
                    .unwrap_or_default()
            }
            "exe_names" => current.exe_names = parse_string_list(value),
            "script_keywords" => current.script_keywords = parse_string_list(value),
            "argv_keywords" => current.argv_keywords = parse_string_list(value),
            "interpreters" => current.interpreters = parse_string_list(value),
            "env_keys" => current.env_keys = parse_string_list(value),
            "exclude_argv" => current.exclude_argv = parse_string_list(value),
            "weak_exe" => current.weak_exe = value.starts_with("true"),
            _ => {}
        }
    }
    rules.retain(|rule| !rule.kind.is_empty());
    rules
}

/// Built-in rules merged with the user's `~/.agent-cli-lab/harnesses.toml`, loaded once.
pub(crate) fn merged_rules() -> &'static [HarnessRule] {
    static RULES: OnceLock<Vec<HarnessRule>> = OnceLock::new();
    RULES.get_or_init(|| {
        let mut rules = builtin_rules();
        if let Some(home) = env::var_os("HOME") {
            let path = PathBuf::from(home)
                .join(".agent-cli-lab")
                .join("harnesses.toml");
            if let Ok(text) = fs::read_to_string(&path) {
                for user in parse_harness_rules(&text) {
                    match rules.iter_mut().find(|rule| rule.kind == user.kind) {
                        Some(slot) => {
                            if !user.exe_names.is_empty() {
                                slot.exe_names = user.exe_names;
                            }
                            if !user.script_keywords.is_empty() {
                                slot.script_keywords = user.script_keywords;
                            }
                            if !user.interpreters.is_empty() {
                                slot.interpreters = user.interpreters;
                            }
                            if !user.exclude_argv.is_empty() {
                                slot.exclude_argv = user.exclude_argv;
                            }
                            slot.weak_exe = slot.weak_exe || user.weak_exe;
                        }
                        None => rules.push(user),
                    }
                }
            }
        }
        rules
    })
}

fn known_install_path(word: &str) -> bool {
    word.contains("/opt/homebrew/")
        || word.contains("/usr/local/bin/")
        || word.contains("/.local/bin/")
}

/// Which harness kind a process command line is, if any, under `rules`. Helper processes that
/// merely belong to an agent (Claude's browser native host, `claude mcp`, version probes, editor
/// extension hosts) are not agents, and neither is this tool's own non-host invocation.
pub(crate) fn detect_kind_with(command: &str, rules: &[HarnessRule]) -> Option<String> {
    let words: Vec<&str> = command.split_whitespace().collect();
    let first_word = words.first()?;
    let first = basename(first_word);
    if first == "agent-cli-lab" {
        return (words.get(1) == Some(&"host")).then(|| "lab".to_string());
    }
    if command.contains("extensionHost") || command.contains("Code Helper") {
        return None;
    }
    if first == "claude"
        && matches!(
            words.get(1).copied(),
            Some("mcp" | "agents" | "update" | "-v")
        )
    {
        return None;
    }
    let mut best: Option<(usize, String)> = None;
    for rule in rules {
        if rule
            .exclude_argv
            .iter()
            .any(|needle| !needle.is_empty() && command.contains(needle.as_str()))
        {
            continue;
        }
        let mut score: Option<usize> = None;
        if rule.exe_names.iter().any(|exe| exe == first) {
            let script_hit = rule.script_keywords.iter().any(|kw| {
                !kw.is_empty() && words.iter().skip(1).any(|word| word.contains(kw.as_str()))
            });
            if !rule.weak_exe || known_install_path(first_word) || script_hit {
                score = Some(50 + first.len());
            }
        }
        if rule.interpreters.iter().any(|interp| interp == first) {
            for word in words.iter().skip(1).take(3) {
                if let Some(kw) = rule
                    .script_keywords
                    .iter()
                    .find(|kw| !kw.is_empty() && word.contains(kw.as_str()))
                {
                    score = Some(score.unwrap_or(0).max(100 + kw.len()));
                }
                if rule.exe_names.iter().any(|exe| exe == basename(word)) {
                    score = Some(score.unwrap_or(0).max(80 + basename(word).len()));
                }
            }
        }
        if let Some(score) = score && best.as_ref().is_none_or(|(top, _)| score > *top) {
            best = Some((score, rule.kind.clone()));
        }
    }
    best.map(|(_, kind)| kind)
}

/// Which agent program a process command line is, if any, under the built-in rules.
pub(crate) fn program_of(command: &str) -> Option<Program> {
    detect_kind_with(command, &builtin_rules()).and_then(|kind| Program::from_kind(&kind))
}

// ------------------------------------------------------------------ lab hosts

#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct HostSpec {
    pub name: Option<String>,
    pub socket: Option<String>,
    pub role: Option<String>,
    pub parent: Option<String>,
    pub model: Option<String>,
    pub hosted: String,
}

/// Reads a `agent-cli-lab host ...` command line. Only the part before ` -- ` is the host's own
/// options; after it comes the program being hosted, whose `--model` must not be mistaken for ours.
pub(crate) fn parse_host(command: &str) -> HostSpec {
    let (head, hosted) = command.split_once(" -- ").unwrap_or((command, ""));
    let mut spec = HostSpec {
        hosted: hosted.trim().to_owned(),
        ..HostSpec::default()
    };
    let mut words = head.split_whitespace();
    while let Some(word) = words.next() {
        let slot = match word {
            "--name" | "-n" => &mut spec.name,
            "-s" | "--socket" => &mut spec.socket,
            "--role" => &mut spec.role,
            "--parent" => &mut spec.parent,
            "--model" => &mut spec.model,
            _ => continue,
        };
        if let Some(value) = words.next() {
            *slot = Some(value.to_owned());
        }
    }
    spec
}

impl HostSpec {
    /// The lab's name: `--name`, else the socket file's stem (older hosts only had `-s`).
    pub fn lab_name(&self) -> Option<String> {
        self.name.clone().or_else(|| {
            self.socket.as_ref().map(|socket| {
                let file = basename(socket);
                file.strip_suffix(".sock").unwrap_or(file).to_owned()
            })
        })
    }

    /// Where the host's control socket may be. Older hosts resolved `-s NAME` under the temp dir.
    pub fn socket_candidates(&self) -> Vec<PathBuf> {
        let mut found = Vec::new();
        if let Some(name) = &self.name && let Ok(path) = session::socket_for(name) {
            found.push(path);
        }
        if let Some(socket) = &self.socket {
            if socket.contains('/') {
                found.push(PathBuf::from(socket));
            } else {
                found.push(env::temp_dir().join(format!("{socket}.sock")));
                found.push(session::session_dir().join(format!("{socket}.sock")));
                found.push(PathBuf::from(socket));
            }
        }
        found
    }

    /// `--provider P --model M` / `--model P/M` of the hosted program.
    pub fn hosted_model(&self) -> Option<String> {
        let words: Vec<&str> = self.hosted.split_whitespace().collect();
        let after = |flag: &str| {
            words
                .iter()
                .position(|w| *w == flag)
                .and_then(|at| words.get(at + 1))
                .map(|w| (*w).to_owned())
        };
        let model = after("--model").or_else(|| after("-m"))?;
        match after("--provider") {
            Some(provider) if !model.contains('/') => Some(format!("{provider}/{model}")),
            _ => Some(model),
        }
    }
}

/// What a lab's host answered about its screen.
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct LabProbe {
    pub state: String,
    pub context: Option<String>,
    pub last: Option<String>,
}

fn footer_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(\d+(?:\.\d+)?)%/(\d+(?:\.\d+)?[kKmM])").unwrap())
}

/// The context figure Pi prints in its footer, for example `12.3%/400k`.
pub(crate) fn footer_context(screen: &str) -> Option<String> {
    footer_regex()
        .captures_iter(screen)
        .last()
        .map(|c| format!("{}%/{}", &c[1], &c[2]))
}

// ------------------------------------------------------------------ redaction and snippets

fn secret_regexes() -> &'static [Regex] {
    static RES: OnceLock<Vec<Regex>> = OnceLock::new();
    RES.get_or_init(|| {
        [
            r"(?:ghp|gho|ghs|ghu|github_pat)_[A-Za-z0-9_]{16,}",
            r"sk-[A-Za-z0-9_-]{16,}",
            r"AKIA[0-9A-Z]{12,}",
            r"(?i)bearer\s+[A-Za-z0-9._~+/=-]{12,}",
            r"[A-Za-z0-9+/_=-]{40,}",
        ]
        .iter()
        .map(|pattern| Regex::new(pattern).unwrap())
        .collect()
    })
}

/// One short line safe to show: secrets and long opaque tokens removed, whitespace collapsed.
pub(crate) fn snippet(text: &str, max: usize) -> String {
    let mut out = text.to_owned();
    for regex in secret_regexes() {
        out = regex.replace_all(&out, "[redacted]").into_owned();
    }
    let collapsed = out.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.chars().count() <= max {
        collapsed
    } else {
        let cut: String = collapsed.chars().take(max.saturating_sub(1)).collect();
        format!("{cut}…")
    }
}

/// The last line of a lab's screen worth showing: not a border, not the input hint.
pub(crate) fn last_screen_line(screen: &str) -> Option<String> {
    screen
        .lines()
        .map(str::trim)
        .rev()
        .find(|line| {
            line.chars().filter(|c| c.is_alphanumeric()).count() >= 8
                && !line.contains("esc to interrupt")
                && !line.contains("auto mode")
                && !line.starts_with('─')
                && footer_context(line).is_none()
        })
        .map(|line| snippet(line, 120))
}

// ------------------------------------------------------------------ Claude Code sessions

#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct ClaudeSession {
    pub pid: u32,
    pub session_id: Option<String>,
    pub cwd: Option<String>,
    pub name: Option<String>,
    pub kind: Option<String>,
    pub status: Option<String>,
}

pub(crate) fn parse_session_file(text: &str) -> Option<ClaudeSession> {
    let value: Value = serde_json::from_str(text).ok()?;
    let word = |key: &str| value.get(key).and_then(Value::as_str).map(str::to_owned);
    let pid = value.get("pid").and_then(|p| {
        p.as_u64()
            .or_else(|| p.as_str().and_then(|s| s.parse().ok()))
    })? as u32;
    Some(ClaudeSession {
        pid,
        session_id: word("sessionId"),
        cwd: word("cwd"),
        name: word("name"),
        kind: word("kind"),
        status: word("status"),
    })
}

fn claude_dir() -> PathBuf {
    env::var_os("CLAUDE_CONFIG_DIR")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| env::var_os("HOME").map(|home| PathBuf::from(home).join(".claude")))
        .unwrap_or_default()
}

fn read_sessions() -> HashMap<u32, ClaudeSession> {
    let dir = claude_dir().join("sessions");
    let mut found = HashMap::new();
    for item in fs::read_dir(dir).into_iter().flatten().flatten() {
        let path = item.path();
        if path.extension().is_none_or(|ext| ext != "json") {
            continue; // the `.key` files beside them are not read
        }
        if let Some(session) = fs::read_to_string(&path)
            .ok()
            .and_then(|text| parse_session_file(&text))
        {
            found.insert(session.pid, session);
        }
    }
    found
}

/// Claude's own word for what the session is doing, in this tool's vocabulary.
pub(crate) fn claude_status(raw: Option<&str>) -> String {
    match raw.unwrap_or("") {
        "busy" | "shell" | "running" | "working" => "working",
        "idle" => "idle",
        "waiting" | "asking" | "permission" | "blocked" => "asking",
        "" => "up",
        other => return other.to_owned(),
    }
    .to_owned()
}

#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct Tail {
    pub model: Option<String>,
    pub tokens: Option<u64>,
    pub last: Option<String>,
}

/// Model, token count and last assistant text from the end of a transcript (`lines`, newest last).
pub(crate) fn tail_of_lines(lines: &[&str]) -> Tail {
    let mut tail = Tail::default();
    for line in lines.iter().rev() {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let message = value.get("message").unwrap_or(&Value::Null);
        let role = message
            .get("role")
            .and_then(Value::as_str)
            .or_else(|| value.get("type").and_then(Value::as_str));
        if role != Some("assistant") {
            continue;
        }
        if tail.model.is_none() {
            tail.model = message
                .get("model")
                .and_then(Value::as_str)
                .filter(|m| !m.starts_with('<'))
                .map(str::to_owned);
        }
        if tail.tokens.is_none() && let Some(usage) = message.get("usage") {
            let count = |key: &str| usage.get(key).and_then(Value::as_u64).unwrap_or(0);
            let total = count("input_tokens")
                + count("cache_read_input_tokens")
                + count("cache_creation_input_tokens");
            if total > 0 {
                tail.tokens = Some(total);
            }
        }
        if tail.last.is_none() {
            let text = message
                .get("content")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter(|i| i.get("type").and_then(Value::as_str) == Some("text"))
                        .filter_map(|i| i.get("text").and_then(Value::as_str))
                        .collect::<Vec<_>>()
                        .join(" ")
                })
                .or_else(|| {
                    message
                        .get("content")
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                })
                .unwrap_or_default();
            if !text.trim().is_empty() {
                tail.last = Some(snippet(&text, 140));
            }
        }
        if tail.model.is_some() && tail.tokens.is_some() && tail.last.is_some() {
            break;
        }
    }
    tail
}

fn read_tail(session_id: &str) -> Option<Tail> {
    let projects = claude_dir().join("projects");
    let file = format!("{session_id}.jsonl");
    let path = fs::read_dir(&projects)
        .ok()?
        .flatten()
        .map(|dir| dir.path().join(&file))
        .find(|path| path.is_file())?;
    let mut handle = fs::File::open(path).ok()?;
    let length = handle.metadata().ok()?.len();
    let window: u64 = 384 * 1024;
    handle
        .seek(SeekFrom::Start(length.saturating_sub(window)))
        .ok()?;
    let mut bytes = Vec::new();
    handle.read_to_end(&mut bytes).ok()?;
    let text = String::from_utf8_lossy(&bytes);
    let mut lines: Vec<&str> = text.lines().collect();
    if length > window && !lines.is_empty() {
        lines.remove(0); // cut mid-line
    }
    Some(tail_of_lines(&lines))
}

fn tokens_label(tokens: u64) -> String {
    if tokens >= 1000 {
        format!("{}k tok", tokens / 1000)
    } else {
        format!("{tokens} tok")
    }
}

// ------------------------------------------------------------------ building the records

/// Who is asking: the ancestors of this process, and the session named in the environment.
#[derive(Debug, Clone, Default)]
pub(crate) struct Me {
    pub ancestors: HashSet<u32>,
    pub session_id: Option<String>,
}

pub(crate) fn ancestors_of(pid: u32, procs: &[Proc]) -> HashSet<u32> {
    let parent: HashMap<u32, u32> = procs.iter().map(|p| (p.pid, p.ppid)).collect();
    let mut found = HashSet::new();
    let mut at = pid;
    while let Some(next) = parent.get(&at).copied() {
        if next <= 1 || !found.insert(next) {
            break;
        }
        at = next;
    }
    found
}

fn tail_tokens_label(tail: &Option<Tail>) -> Option<String> {
    tail.as_ref().and_then(|t| t.tokens).map(tokens_label)
}

/// All agent records for a machine described by the arguments. Pure: no I/O except through the
/// two lookups, which the caller supplies.
pub(crate) fn build(
    procs: &[Proc],
    cwds: &HashMap<u32, String>,
    sessions: &HashMap<u32, ClaudeSession>,
    probes: &HashMap<u32, LabProbe>,
    tail_of: &dyn Fn(&str) -> Option<Tail>,
    me: &Me,
) -> Vec<AgentRec> {
    let mut children: HashMap<u32, Vec<&Proc>> = HashMap::new();
    for process in procs {
        children.entry(process.ppid).or_default().push(process);
    }
    let by_pid: HashMap<u32, &Proc> = procs.iter().map(|p| (p.pid, p)).collect();
    let mut claimed: HashSet<u32> = HashSet::new();
    let mut records: Vec<AgentRec> = Vec::new();

    // labs: one record per host, describing the agent it hosts
    for host in procs
        .iter()
        .filter(|p| program_of(&p.command) == Some(Program::LabHost))
    {
        claimed.insert(host.pid);
        let spec = parse_host(&host.command);
        let mut kids = children.get(&host.pid).cloned().unwrap_or_default();
        kids.sort_by_key(|p| p.pid);
        let agent = kids
            .iter()
            .find(|p| program_of(&p.command).is_some_and(|program| program != Program::LabHost))
            .or_else(|| kids.first())
            .copied();
        if let Some(agent) = agent {
            claimed.insert(agent.pid);
        }
        let program = agent.and_then(|a| program_of(&a.command));
        let kind = program
            .map(|p| p.kind().to_owned())
            .or_else(|| {
                spec.hosted
                    .split_whitespace()
                    .next()
                    .map(|word| basename(word).to_owned())
            })
            .unwrap_or_else(|| "program".into());
        let session = agent.and_then(|a| sessions.get(&a.pid));
        let tail = session
            .and_then(|s| s.session_id.as_deref())
            .and_then(tail_of);
        let probe = probes.get(&host.pid);
        let pid = agent.map(|a| a.pid).unwrap_or(host.pid);
        let this_session = agent.is_some_and(|a| me.ancestors.contains(&a.pid));
        records.push(AgentRec {
            kind: Some(kind),
            name: spec.lab_name(),
            role: spec.role.clone(),
            parent: spec.parent.clone(),
            pid: Some(pid as u64),
            host_pid: Some(host.pid as u64),
            cwd: cwds.get(&pid).or_else(|| cwds.get(&host.pid)).cloned(),
            model: spec
                .model
                .clone()
                .or_else(|| spec.hosted_model())
                .or_else(|| tail.as_ref().and_then(|t| t.model.clone())),
            status: Some(probe.map(|p| p.state.clone()).unwrap_or_else(|| {
                if agent.is_some() {
                    "up".into()
                } else {
                    "gone".into()
                }
            })),
            context: probe
                .and_then(|p| p.context.clone())
                .or_else(|| tail_tokens_label(&tail)),
            uptime: Some(human_duration(host.age_secs * 1000)),
            last: tail
                .as_ref()
                .and_then(|t| t.last.clone())
                .or_else(|| probe.and_then(|p| p.last.clone())),
            tty: agent
                .and_then(|a| a.tty.clone())
                .or_else(|| host.tty.clone()),
            session_id: session.and_then(|s| s.session_id.clone()),
            source: Some("lab".into()),
            managed: true,
            this_session,
        });
    }

    // agents nobody hosts: Claude sessions Claude itself reports, then every other agent process
    for process in procs {
        if claimed.contains(&process.pid) {
            continue;
        }
        let Some(kind) = detect_kind_with(&process.command, merged_rules()) else {
            continue;
        };
        if kind == "lab" {
            continue;
        }
        // One record per session: a same-kind child of another detected agent is a helper or a
        // wrapper/interpreter chain for that session, not a second instance.
        if procs.iter().any(|parent| {
            parent.pid == process.ppid
                && parent.pid != process.pid
                && detect_kind_with(&parent.command, merged_rules()).as_deref()
                    == Some(kind.as_str())
        }) {
            continue;
        }
        let parent_command = by_pid
            .get(&process.ppid)
            .map(|p| p.command.as_str())
            .unwrap_or("");
        let uptime = Some(human_duration(process.age_secs * 1000));
        let cwd = cwds.get(&process.pid).cloned();
        let by_cpu = if process.cpu >= 2.0 {
            "working"
        } else {
            "idle"
        };
        if kind == "claude" {
            let session = sessions.get(&process.pid);
            let tail = session
                .and_then(|s| s.session_id.as_deref())
                .and_then(tail_of);
            let this_session = me.ancestors.contains(&process.pid)
                || session
                    .and_then(|s| s.session_id.as_deref())
                    .is_some_and(|id| me.session_id.as_deref() == Some(id));
            let name = session
                .and_then(|s| s.name.clone())
                .or_else(|| {
                    session
                        .and_then(|s| s.session_id.as_ref().map(|id| id.chars().take(8).collect()))
                })
                .unwrap_or_else(|| format!("claude-{}", process.pid));
            records.push(AgentRec {
                kind: Some("claude".into()),
                name: Some(name),
                role: Some(if this_session {
                    "this session (commander)".into()
                } else {
                    "interactive session".into()
                }),
                pid: Some(process.pid as u64),
                cwd: session.and_then(|s| s.cwd.clone()).or(cwd),
                model: tail.as_ref().and_then(|t| t.model.clone()),
                status: Some(
                    session
                        .map(|s| claude_status(s.status.as_deref()))
                        .unwrap_or_else(|| by_cpu.into()),
                ),
                context: tail_tokens_label(&tail),
                uptime,
                last: tail.as_ref().and_then(|t| t.last.clone()),
                tty: process.tty.clone(),
                session_id: session.and_then(|s| s.session_id.clone()),
                source: Some(
                    if session.is_some() {
                        "claude-session"
                    } else {
                        "process"
                    }
                    .into(),
                ),
                managed: false,
                this_session,
                ..AgentRec::default()
            });
            continue;
        }
        let editor = parent_command.contains("external_agents") || parent_command.contains("Zed");
        records.push(AgentRec {
            kind: Some(kind.clone()),
            name: Some(if editor {
                format!("{} (editor)", kind)
            } else {
                format!("{}-{}", kind, process.pid)
            }),
            role: Some(if editor {
                "editor agent".into()
            } else {
                "standalone".into()
            }),
            pid: Some(process.pid as u64),
            cwd,
            tty: process.tty.clone(),
            model: parse_model_from_command(&process.command),
            status: Some(by_cpu.into()),
            uptime,
            source: Some("process".into()),
            ..AgentRec::default()
        });
    }

    records.sort_by(|a, b| {
        (!a.this_session, a.managed, a.kind.clone(), a.name.clone()).cmp(&(
            !b.this_session,
            b.managed,
            b.kind.clone(),
            b.name.clone(),
        ))
    });
    records
}

fn parse_model_from_command(command: &str) -> Option<String> {
    let words: Vec<&str> = command.split_whitespace().collect();
    let model = words
        .iter()
        .position(|w| *w == "--model" || *w == "-m")
        .and_then(|at| words.get(at + 1))?;
    Some((*model).to_owned())
}

// ------------------------------------------------------------------ the real machine

pub(crate) struct ScanOptions {
    /// Ask each lab's host for its screen (state, context). Slower; off for a quick listing.
    pub probe: bool,
    pub stalled_ms: u64,
}

fn run_ps() -> Vec<Proc> {
    Command::new("ps")
        .args(["-axww", "-o", "pid=,ppid=,etime=,pcpu=,tty=,command="])
        .output()
        .map(|out| parse_ps(&String::from_utf8_lossy(&out.stdout)))
        .unwrap_or_default()
}

fn read_cwds(pids: &[u32]) -> HashMap<u32, String> {
    let mut found = HashMap::new();
    if pids.is_empty() {
        return found;
    }
    if cfg!(target_os = "linux") {
        for pid in pids {
            if let Ok(path) = fs::read_link(format!("/proc/{pid}/cwd")) {
                found.insert(*pid, path.display().to_string());
            }
        }
        return found;
    }
    let list = pids
        .iter()
        .map(u32::to_string)
        .collect::<Vec<_>>()
        .join(",");
    let Ok(out) = Command::new("lsof")
        .args(["-a", "-d", "cwd", "-Fpn", "-p", &list])
        .output()
    else {
        return found;
    };
    let mut current: Option<u32> = None;
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        match line.split_at_checked(1) {
            Some(("p", rest)) => current = rest.parse().ok(),
            Some(("n", rest)) => {
                if let Some(pid) = current {
                    found.insert(pid, rest.to_owned());
                }
            }
            _ => {}
        }
    }
    found
}

fn probe_lab(spec: &HostSpec, stalled_ms: u64) -> Option<LabProbe> {
    let timeout = Duration::from_millis(1500);
    for socket in spec.socket_candidates() {
        let Ok(answer) = request_with_timeout(&socket, json!({ "op": "screen" }), timeout) else {
            continue;
        };
        let screen = answer
            .get("screen")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let status = request_with_timeout(&socket, json!({ "op": "status" }), timeout).ok();
        let quiet = status
            .as_ref()
            .and_then(|s| s.get("quiet_ms"))
            .and_then(Value::as_u64);
        let running = status
            .as_ref()
            .and_then(|s| s.get("running"))
            .and_then(Value::as_bool)
            .unwrap_or(true);
        let state = if !running {
            "exited"
        } else {
            match quiet {
                Some(quiet) => state::classify(&screen, quiet, stalled_ms).name(),
                None if state::is_asking(&screen) => "asking",
                None => "up",
            }
        };
        return Some(LabProbe {
            state: state.into(),
            context: footer_context(&screen),
            last: last_screen_line(&screen),
        });
    }
    None
}

/// Every agent instance on this machine.
pub(crate) fn scan(options: &ScanOptions) -> Vec<AgentRec> {
    let procs = run_ps();
    let mut wanted: Vec<u32> = procs
        .iter()
        .filter(|p| detect_kind_with(&p.command, merged_rules()).is_some())
        .map(|p| p.pid)
        .collect();
    wanted.sort_unstable();
    let cwds = read_cwds(&wanted);
    let sessions = read_sessions();

    let mut probes: HashMap<u32, LabProbe> = HashMap::new();
    if options.probe {
        let hosts: Vec<(u32, HostSpec)> = procs
            .iter()
            .filter(|p| program_of(&p.command) == Some(Program::LabHost))
            .map(|p| (p.pid, parse_host(&p.command)))
            .collect();
        let stalled_ms = options.stalled_ms;
        let found: Vec<(u32, Option<LabProbe>)> = thread::scope(|scope| {
            let handles: Vec<_> = hosts
                .iter()
                .map(|(pid, spec)| scope.spawn(move || (*pid, probe_lab(spec, stalled_ms))))
                .collect();
            handles
                .into_iter()
                .filter_map(|handle| handle.join().ok())
                .collect()
        });
        probes.extend(
            found
                .into_iter()
                .filter_map(|(pid, probe)| probe.map(|p| (pid, p))),
        );
    }

    let me = Me {
        ancestors: ancestors_of(std::process::id(), &procs),
        session_id: env::var("CLAUDE_CODE_SESSION_ID")
            .ok()
            .filter(|v| !v.is_empty()),
    };
    build(&procs, &cwds, &sessions, &probes, &read_tail, &me)
}

// ------------------------------------------------------------------ the command

#[derive(Debug, Args)]
pub(crate) struct AgentsArgs {
    /// Print JSON (`{generatedAt, agents: [...]}`) instead of a table.
    #[arg(long)]
    json: bool,
    /// Only agents of this kind: any built-in kind, or a custom kind from ~/.agent-cli-lab/harnesses.toml.
    #[arg(long, value_name = "KIND")]
    kind: Option<String>,
    /// Skip asking each lab's host for its screen: faster, but no working/asking/stalled for labs.
    #[arg(long)]
    no_probe: bool,
    /// Keep running: scan every N seconds (use with --publish, or to refresh the printed table).
    #[arg(long, value_name = "SECONDS")]
    watch: Option<u64>,
    /// Also write the JSON atomically to PATH (default ~/.agent-cli-lab/agents.json) for the GUI and other readers.
    #[arg(long, value_name = "PATH", num_args = 0..=1, default_missing_value = "")]
    publish: Option<String>,
    /// Quiet time (ms) after which a lab counts as stalled.
    #[arg(long, default_value_t = 8000, value_name = "MS")]
    stalled_ms: u64,
}

pub(crate) fn default_publish_path() -> PathBuf {
    env::var_os("AGENT_CLI_LAB_AGENTS")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            env::var_os("HOME")
                .map(PathBuf::from)
                .unwrap_or_default()
                .join(".agent-cli-lab")
                .join("agents.json")
        })
}

fn civil_utc(secs: u64) -> String {
    // days since 1970-01-01 to a civil date (Howard Hinnant's algorithm)
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { year + 1 } else { year };
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}

pub(crate) fn registry_now(agents: Vec<AgentRec>) -> Registry {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    Registry {
        generated_at: Some(civil_utc(secs)),
        agents,
    }
}

fn publish(registry: &Registry, path: &Path) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("failed to create {}", parent.display()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(parent, fs::Permissions::from_mode(0o700));
        }
    }
    let temporary = path.with_extension("json.tmp");
    fs::write(&temporary, serde_json::to_vec_pretty(registry)?)
        .with_context(|| format!("failed to write {}", temporary.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&temporary, fs::Permissions::from_mode(0o600));
    }
    fs::rename(&temporary, path).with_context(|| format!("failed to write {}", path.display()))
}

fn tail_path(text: &str, width: usize) -> String {
    let count = text.chars().count();
    if count <= width {
        text.to_owned()
    } else {
        let tail: String = text.chars().skip(count - (width - 1)).collect();
        format!("…{tail}")
    }
}

pub(crate) fn render_table(registry: &Registry) -> String {
    let mut by_kind: Vec<(String, usize)> = Vec::new();
    for agent in &registry.agents {
        let kind = agent.kind.clone().unwrap_or_else(|| "other".into());
        match by_kind.iter_mut().find(|(k, _)| *k == kind) {
            Some((_, n)) => *n += 1,
            None => by_kind.push((kind, 1)),
        }
    }
    by_kind.sort();
    let working = registry
        .agents
        .iter()
        .filter(|a| a.status.as_deref() == Some("working"))
        .count();
    let mut out = format!(
        "{} agent instance{} ({} working) · {}\n",
        registry.agents.len(),
        if registry.agents.len() == 1 { "" } else { "s" },
        working,
        by_kind
            .iter()
            .map(|(k, n)| format!("{k} {n}"))
            .collect::<Vec<_>>()
            .join(", ")
    );
    out.push_str(&format!(
        "{:<9} {:<26} {:<24} {:<9} {:<28} {:<11} {:<8} {:>6}  {}\n",
        "KIND", "NAME", "ROLE", "STATUS", "MODEL", "CTX", "UP", "PID", "CWD"
    ));
    for agent in &registry.agents {
        let name = agent.name.clone().unwrap_or_else(|| "-".into());
        let name = if agent.this_session {
            format!("◆ {name}")
        } else {
            name
        };
        out.push_str(&format!(
            "{:<9} {:<26} {:<24} {:<9} {:<28} {:<11} {:<8} {:>6}  {}\n",
            agent.kind.clone().unwrap_or_else(|| "-".into()),
            tail_path(&name, 26),
            tail_path(&agent.role.clone().unwrap_or_else(|| "-".into()), 24),
            agent.status.clone().unwrap_or_else(|| "-".into()),
            tail_path(&agent.model.clone().unwrap_or_else(|| "-".into()), 28),
            agent.context.clone().unwrap_or_else(|| "-".into()),
            agent.uptime.clone().unwrap_or_else(|| "-".into()),
            agent
                .pid
                .map(|p| p.to_string())
                .unwrap_or_else(|| "-".into()),
            tail_path(&agent.cwd.clone().unwrap_or_default(), 34),
        ));
    }
    out
}

pub(crate) fn run(args: AgentsArgs) -> Result<i32> {
    let options = ScanOptions {
        probe: !args.no_probe,
        stalled_ms: args.stalled_ms,
    };
    let publish_to = args.publish.as_ref().map(|path| {
        if path.is_empty() {
            default_publish_path()
        } else {
            PathBuf::from(path)
        }
    });
    loop {
        let mut agents = scan(&options);
        if let Some(kind) = &args.kind {
            agents.retain(|agent| agent.kind.as_deref() == Some(kind.as_str()));
        }
        let registry = registry_now(agents);
        if let Some(path) = &publish_to {
            publish(&registry, path)?;
        }
        if args.json {
            println!("{}", serde_json::to_string(&registry)?);
        } else {
            print!("{}", render_table(&registry));
        }
        match args.watch {
            Some(seconds) => thread::sleep(Duration::from_secs(seconds.max(1))),
            None => return Ok(0),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PS: &str = "\
76581 10855    05:09:12  11.6 claude
85026 84716 21:02:44   0.3 claude
80511 80489    04:50:51   0.0 /Users/me/.local/bin/claude --chrome-native-host
12412     1    02:49:03   0.2 /x/target/debug/agent-cli-lab host --name cmdr-expense --role commander --parent boss --model muse/muse -C 150 -R 40 --title cmdr-expense (muse) --cwd /w/exp -- pi --provider muse --model muse --thinking off --no-session
12413 12412    02:49:03   0.0 pi
65059     1       21:42   0.2 /x/target/debug/agent-cli-lab host --name aws -C 150 -R 40 --title aws lab (claude sonnet, chrome, rc) -- env -u CLAUDE_CODE_SESSION_ID claude --chrome --model claude-sonnet-5-5
65060 65059       21:42   5.0 claude --chrome --remote-control aws-lab --model claude-sonnet-5-5
25038     1    01:55:23   0.0 agent-cli-lab host -s abac-mgr -C 150 -R 40 -- pi --provider muse --model muse --thinking off --no-session
25040 25038    01:55:23   0.0 pi
66824     1       17:48   0.1 agent-cli-lab host -s /var/T/aws-deploy.sock -r /h/.lab-commander/aws-deploy.jsonl -C 14 -- pi --model opencode-cli/opencode/gpt-6-luna
8283      1 17-00:23:55   0.0 /Applications/Zed.app/Contents/MacOS/zed external_agents/registry/npx
8284   8283 17-00:23:55   9.9 pi
4001    900       00:10   0.0 /opt/homebrew/bin/opencode run -m opencode/big-pickle hi
";

    fn sessions() -> HashMap<u32, ClaudeSession> {
        let mut map = HashMap::new();
        map.insert(
            76581,
            ClaudeSession {
                pid: 76581,
                session_id: Some("f0cedc99-aaaa".into()),
                cwd: Some("/Users/me/Downloads".into()),
                name: Some("ghostty commander".into()),
                kind: Some("interactive".into()),
                status: Some("busy".into()),
            },
        );
        map.insert(
            85026,
            ClaudeSession {
                pid: 85026,
                session_id: Some("e41979bd-bbbb".into()),
                cwd: Some("/Users/me/Downloads".into()),
                name: Some("downloads-9b".into()),
                kind: Some("interactive".into()),
                status: Some("idle".into()),
            },
        );
        map.insert(
            65060,
            ClaudeSession {
                pid: 65060,
                session_id: Some("74dc4afc-cccc".into()),
                cwd: Some("/Users/me/Downloads".into()),
                name: Some("aws".into()),
                kind: Some("interactive".into()),
                status: Some("busy".into()),
            },
        );
        map
    }

    fn records(me: Me) -> Vec<AgentRec> {
        let procs = parse_ps(PS);
        let mut probes = HashMap::new();
        probes.insert(
            12412,
            LabProbe {
                state: "working".into(),
                context: Some("12.3%/400k".into()),
                last: Some("editing redline.ts".into()),
            },
        );
        let tail = |id: &str| {
            (id == "f0cedc99-aaaa").then(|| Tail {
                model: Some("claude-sonnet-5-5".into()),
                tokens: Some(210_345),
                last: Some("running the sweep".into()),
            })
        };
        build(&procs, &HashMap::new(), &sessions(), &probes, &tail, &me)
    }

    fn find<'a>(records: &'a [AgentRec], name: &str) -> &'a AgentRec {
        records
            .iter()
            .find(|r| r.name.as_deref() == Some(name))
            .unwrap_or_else(|| panic!("no {name} in {records:#?}"))
    }

    #[test]
    fn etime_formats_parse() {
        assert_eq!(parse_etime("05:09"), Some(309));
        assert_eq!(parse_etime("02:49:03"), Some(10_143));
        assert_eq!(parse_etime("17-00:23:55"), Some(17 * 86_400 + 1435));
        assert_eq!(parse_etime("nope"), None);
    }

    #[test]
    fn ps_lines_keep_the_whole_command() {
        let procs = parse_ps(PS);
        assert_eq!(procs.len(), 13);
        let host = procs.iter().find(|p| p.pid == 12412).unwrap();
        assert_eq!((host.ppid, host.age_secs), (1, 10_143));
        assert!(
            host.command.ends_with("--no-session")
                && host.command.contains("--title cmdr-expense (muse)")
        );
    }

    #[test]
    fn programs_are_recognised_and_helpers_are_not_agents() {
        assert_eq!(program_of("claude"), Some(Program::Claude));
        assert_eq!(
            program_of("/Users/me/.local/bin/claude --chrome-native-host"),
            None
        );
        assert_eq!(program_of("claude mcp serve"), None);
        assert_eq!(program_of("pi"), Some(Program::Pi));
        assert_eq!(
            program_of("node /usr/lib/node_modules/opencode run"),
            Some(Program::Opencode)
        );
        assert_eq!(
            program_of("/opt/homebrew/bin/opencode run -m x"),
            Some(Program::Opencode)
        );
        assert_eq!(
            program_of("agent-cli-lab host --name x -- pi"),
            Some(Program::LabHost)
        );
        assert_eq!(program_of("agent-cli-lab list"), None);
        assert_eq!(program_of("python3 pi.py"), None);
        assert_eq!(program_of("/Applications/Zed.app/Contents/MacOS/zed"), None);
    }

    #[test]
    fn script_paths_and_weak_namesakes_follow_the_rules() {
        let rules = builtin_rules();
        assert_eq!(
            detect_kind_with("python3 /home/me/.venv/lib/aider/main.py --model x", &rules)
                .as_deref(),
            Some("aider")
        );
        assert_eq!(
            detect_kind_with(
                "node /usr/local/lib/node_modules/@qwen-code/qwen-code/cli.js",
                &rules
            )
            .as_deref(),
            Some("qwen")
        );
        assert_eq!(detect_kind_with("amp chat", &rules), None);
        assert_eq!(
            detect_kind_with("/opt/homebrew/bin/amp chat", &rules).as_deref(),
            Some("amp")
        );
        assert_eq!(detect_kind_with("goose run", &rules), None);
    }

    #[test]
    fn user_rules_parse_and_detect_custom_kinds() {
        let rules = parse_harness_rules(
            "[[harness]]\nkind = \"myagent\"\nexe_names = [\"myagent\"]\nscript_keywords = [\"myagent/run.js\"]\nexclude_argv = [\"--daemon\"]\n",
        );
        assert_eq!(rules.len(), 1);
        assert_eq!(
            detect_kind_with("myagent chat", &rules).as_deref(),
            Some("myagent")
        );
        assert_eq!(
            detect_kind_with("node /opt/tools/myagent/run.js", &rules).as_deref(),
            Some("myagent")
        );
        assert_eq!(detect_kind_with("myagent --daemon", &rules), None);
        assert!(
            parse_harness_rules("kind = \"orphan\"\n[[harness]]\nexe_names = [\"x\"]\n").is_empty()
        );
    }

    #[test]
    fn same_kind_children_are_one_record() {
        let procs = vec![
            Proc {
                pid: 500,
                ppid: 1,
                age_secs: 60,
                cpu: 0.0,
                command: "pi".into(),
                tty: Some("ttys001".into()),
            },
            Proc {
                pid: 501,
                ppid: 500,
                age_secs: 60,
                cpu: 0.0,
                command: "node /usr/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js"
                    .into(),
                tty: None,
            },
        ];
        let tail = |_: &str| -> Option<Tail> { None };
        let records = build(
            &procs,
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            &tail,
            &Me::default(),
        );
        let pis: Vec<&AgentRec> = records
            .iter()
            .filter(|r| r.kind.as_deref() == Some("pi"))
            .collect();
        assert_eq!(pis.len(), 1);
        assert_eq!(pis[0].pid, Some(500));
        assert_eq!(pis[0].tty.as_deref(), Some("ttys001"));
    }

    #[test]
    fn host_options_are_read_from_before_the_separator_only() {
        let spec = parse_host(
            "/x/agent-cli-lab host --name w1 --role worker --parent mgr --model muse/muse -C 150 --title a b -- pi --provider other --model hosted",
        );
        assert_eq!(
            (
                spec.name.as_deref(),
                spec.role.as_deref(),
                spec.parent.as_deref(),
                spec.model.as_deref()
            ),
            (Some("w1"), Some("worker"), Some("mgr"), Some("muse/muse"))
        );
        assert_eq!(spec.hosted_model().as_deref(), Some("other/hosted"));
        let legacy = parse_host("agent-cli-lab host -s /var/T/aws-deploy.sock -r log.jsonl -- pi");
        assert_eq!(legacy.lab_name().as_deref(), Some("aws-deploy"));
        let short = parse_host("agent-cli-lab host -s abac-mgr -C 150 -- pi");
        assert_eq!(short.lab_name().as_deref(), Some("abac-mgr"));
        assert!(
            short
                .socket_candidates()
                .iter()
                .any(|p| p.to_string_lossy().ends_with("abac-mgr.sock"))
        );
    }

    #[test]
    fn labs_become_one_record_per_host_with_the_hosted_agent() {
        let found = records(Me::default());
        let expense = find(&found, "cmdr-expense");
        assert_eq!(expense.kind.as_deref(), Some("pi"));
        assert_eq!(
            (expense.role.as_deref(), expense.parent.as_deref()),
            (Some("commander"), Some("boss"))
        );
        assert_eq!(expense.model.as_deref(), Some("muse/muse"));
        assert_eq!(
            (expense.status.as_deref(), expense.context.as_deref()),
            (Some("working"), Some("12.3%/400k"))
        );
        assert_eq!((expense.pid, expense.host_pid), (Some(12413), Some(12412)));
        assert!(expense.managed);
        let aws = find(&found, "aws");
        assert_eq!(aws.kind.as_deref(), Some("claude"));
        assert_eq!(
            aws.session_id.as_deref(),
            Some("74dc4afc-cccc"),
            "the lab's Claude session is joined by pid"
        );
        // the hosted agents are not listed a second time
        assert_eq!(
            found
                .iter()
                .filter(|r| r.pid == Some(12413) || r.pid == Some(65060) || r.pid == Some(25040))
                .count(),
            3
        );
        assert_eq!(found.iter().filter(|r| r.managed).count(), 4);
        assert_eq!(
            find(&found, "abac-mgr").status.as_deref(),
            Some("up"),
            "a lab nobody could probe is still listed"
        );
    }

    #[test]
    fn standalone_agents_include_the_users_own_claude_session() {
        let found = records(Me {
            ancestors: HashSet::from([76581]),
            session_id: None,
        });
        let mine = find(&found, "ghostty commander");
        assert!(mine.this_session && !mine.managed);
        assert_eq!(mine.role.as_deref(), Some("this session (commander)"));
        assert_eq!(
            (
                mine.model.as_deref(),
                mine.context.as_deref(),
                mine.last.as_deref()
            ),
            (
                Some("claude-sonnet-5-5"),
                Some("210k tok"),
                Some("running the sweep")
            )
        );
        assert_eq!(mine.status.as_deref(), Some("working"));
        assert_eq!(
            found[0].name.as_deref(),
            Some("ghostty commander"),
            "listed first"
        );
        let other = find(&found, "downloads-9b");
        assert!(!other.this_session);
        assert_eq!(
            (other.role.as_deref(), other.status.as_deref()),
            (Some("interactive session"), Some("idle"))
        );
        assert!(
            found.iter().all(|r| r.pid != Some(80511)),
            "the browser native host is not an agent"
        );
    }

    #[test]
    fn the_session_in_the_environment_marks_this_session_too() {
        let found = records(Me {
            ancestors: HashSet::new(),
            session_id: Some("e41979bd-bbbb".into()),
        });
        assert!(find(&found, "downloads-9b").this_session);
        assert!(!find(&found, "ghostty commander").this_session);
    }

    #[test]
    fn other_agent_programs_and_editor_agents_are_found() {
        let found = records(Me::default());
        let editor = found.iter().find(|r| r.pid == Some(8284)).unwrap();
        assert_eq!(
            (
                editor.kind.as_deref(),
                editor.name.as_deref(),
                editor.role.as_deref()
            ),
            (Some("pi"), Some("pi (editor)"), Some("editor agent"))
        );
        assert_eq!(editor.status.as_deref(), Some("working"), "busy by CPU");
        let open = found.iter().find(|r| r.pid == Some(4001)).unwrap();
        assert_eq!(
            (
                open.kind.as_deref(),
                open.model.as_deref(),
                open.status.as_deref()
            ),
            (Some("opencode"), Some("opencode/big-pickle"), Some("idle"))
        );
    }

    #[test]
    fn ancestors_walk_up_to_the_session() {
        let procs = parse_ps(
            "76581 1 01:00:00 1.0 claude\n300 76581 00:10 0.0 zsh\n301 300 00:05 0.0 agent-cli-lab agents\n",
        );
        assert_eq!(ancestors_of(301, &procs), HashSet::from([300, 76581]));
    }

    #[test]
    fn session_files_parse_with_numeric_or_string_pids() {
        let a = parse_session_file(r#"{"pid":76581,"sessionId":"s1","cwd":"/w","name":"n","kind":"interactive","status":"busy"}"#).unwrap();
        assert_eq!(
            (a.pid, a.session_id.as_deref(), a.status.as_deref()),
            (76581, Some("s1"), Some("busy"))
        );
        assert_eq!(
            parse_session_file(r#"{"pid":"23317","sessionId":"s2"}"#)
                .unwrap()
                .pid,
            23317
        );
        assert!(parse_session_file("{ broken").is_none());
        assert_eq!(claude_status(Some("busy")), "working");
        assert_eq!(claude_status(Some("shell")), "working");
        assert_eq!(claude_status(Some("idle")), "idle");
        assert_eq!(claude_status(Some("permission")), "asking");
        assert_eq!(claude_status(None), "up");
    }

    #[test]
    fn transcript_tail_gives_model_tokens_and_a_redacted_last_message() {
        // token-shaped strings are assembled at run time so no secret-looking literal sits in the source
        let fake_token = ["ghp", "_abcdefghijklmnopqrstuvwxyz0123456789"].concat();
        let leaky = r#"{"type":"assistant","message":{"role":"assistant","model":"claude-sonnet-5-5","content":[{"type":"text","text":"Pushed with token FAKETOKEN and   spaces"}],"usage":{"input_tokens":3,"cache_read_input_tokens":200000,"cache_creation_input_tokens":400,"output_tokens":9}}}"#.replace("FAKETOKEN", &fake_token);
        let lines = [
            r#"{"type":"user","message":{"role":"user","content":"hello"}}"#,
            r#"{"type":"assistant","message":{"role":"assistant","model":"claude-opus-5-5","content":[{"type":"text","text":"older reply"}],"usage":{"input_tokens":10,"cache_read_input_tokens":1000,"output_tokens":5}}}"#,
            &leaky,
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"Bash"}]}}"#,
            "not json at all",
        ];
        let tail = tail_of_lines(&lines);
        assert_eq!(tail.model.as_deref(), Some("claude-sonnet-5-5"));
        assert_eq!(tail.tokens, Some(200_403));
        let last = tail.last.unwrap();
        assert!(
            last.contains("[redacted]") && !last.contains("ghp_") && last.contains("and spaces"),
            "{last}"
        );
        assert_eq!(tokens_label(200_403), "200k tok");
        assert_eq!(tokens_label(850), "850 tok");
    }

    #[test]
    fn snippets_redact_and_truncate() {
        assert_eq!(
            snippet("use Bearer abcdefghijklmnop1234 now", 80),
            "use [redacted] now"
        );
        let aws_key = ["AKIA", "ABCDEFGHIJKLMNOP"].concat();
        assert_eq!(
            snippet(&format!("key {aws_key} end"), 80),
            "key [redacted] end"
        );
        let long = "word ".repeat(60);
        assert!(snippet(&long, 30).ends_with('…') && snippet(&long, 30).chars().count() <= 30);
    }

    #[test]
    fn lab_screens_give_a_context_footer_and_a_last_line() {
        let screen = " editing src/redline.ts now\n────────────\n                                  12.3%/400k (auto)   (muse) muse\n  esc to interrupt\n";
        assert_eq!(footer_context(screen).as_deref(), Some("12.3%/400k"));
        assert_eq!(
            last_screen_line(screen).as_deref(),
            Some("editing src/redline.ts now")
        );
        assert_eq!(footer_context("nothing here"), None);
    }

    #[test]
    fn table_and_json_cover_every_kind() {
        let registry = registry_now(records(Me {
            ancestors: HashSet::from([76581]),
            session_id: None,
        }));
        let table = render_table(&registry);
        assert!(table.starts_with("8 agent instances"), "{table}");
        for needle in [
            "◆ ghostty commander",
            "cmdr-expense",
            "claude",
            "opencode",
            "pi (editor)",
        ] {
            assert!(table.contains(needle), "{needle} missing in\n{table}");
        }
        let json = serde_json::to_value(&registry).unwrap();
        assert!(json["generatedAt"].as_str().unwrap().ends_with('Z'));
        assert_eq!(json["agents"].as_array().unwrap().len(), 8);
        assert_eq!(json["agents"][0]["thisSession"], true);
        let back: Registry = serde_json::from_value(json).unwrap();
        assert_eq!(back.agents.len(), 8);
    }

    #[test]
    fn dates_are_formatted_in_utc() {
        assert_eq!(civil_utc(0), "1970-01-01T00:00:00Z");
        assert_eq!(civil_utc(1_793_685_967), "2026-11-03T06:06:07Z");
    }

    #[test]
    fn every_builtin_harness_is_detected_from_script_paths() {
        let rules = builtin_rules();
        let cases: &[(&str, &str)] = &[
            (
                "claude",
                "node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js",
            ),
            (
                "pi",
                "node /usr/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
            ),
            ("opencode", "node /usr/lib/node_modules/opencode/bin/cli.js"),
            ("codex", "node /usr/lib/node_modules/@openai/codex/cli.js"),
            (
                "gemini",
                "node /usr/lib/node_modules/@google/gemini-cli/bundle/gemini.js",
            ),
            ("aider", "python3 -m aider"),
            (
                "cursor-agent",
                "node /usr/lib/node_modules/cursor-agent/dist/cli.js",
            ),
            ("goose", "node /opt/tools/goose/dist/cli.js"),
            ("amp", "node /usr/lib/node_modules/@sourcegraph/amp/cli.js"),
            (
                "crush",
                "node /usr/lib/node_modules/@charmland/crush/cli.js",
            ),
            ("qwen", "bun /opt/tools/@qwen-code/qwen-code/cli.js"),
            (
                "kimi",
                "node /usr/lib/node_modules/@moonshot-ai/kimi-code/cli.js",
            ),
            ("droid", "node /usr/lib/node_modules/droid/cli.js"),
            ("copilot-cli", "node /usr/lib/node_modules/copilot/cli.js"),
            ("cline", "node /usr/lib/node_modules/@cline/sdk/cli.js"),
            (
                "continue",
                "node /usr/lib/node_modules/@continuedev/continue/cli.js",
            ),
            (
                "cody",
                "node /usr/lib/node_modules/@sourcegraph/cody/cli.js",
            ),
        ];
        assert_eq!(rules.len(), cases.len(), "one fixture per builtin rule");
        for (kind, command) in cases {
            assert_eq!(
                detect_kind_with(command, &rules).as_deref(),
                Some(*kind),
                "{command}"
            );
        }
    }

    #[test]
    fn false_positive_commands_are_not_agents() {
        let rules = builtin_rules();
        for command in [
            "/Applications/Cursor.app/Contents/MacOS/Cursor /w",
            "node /usr/lib/vscode/extensions/codex/dist/extensionHost.js",
            "node /opt/tools/@modelcontextprotocol/server-filesystem/index.js /tmp",
            "node /opt/tools/claude-mcp-server/index.js",
            "/opt/homebrew/bin/claude --chrome-native-host",
            "codex --version",
            "gemini --help",
            "opencode --version",
            "aider --help",
            "agent-cli-lab agents --json",
            "agent-cli-lab status",
            "/x/target/debug/agent-cli-lab screen -n w1",
            "node /usr/lib/node_modules/typescript/bin/tsserver",
            "node /srv/app/server.js",
            "bun run dev",
            "crush run",
            "droid chat",
            "cline chat",
            "cody chat",
            "cn chat",
        ] {
            assert_eq!(detect_kind_with(command, &rules), None, "{command}");
        }
    }

    #[test]
    fn fixture_table_builds_every_harness_once_and_dedupes_children() {
        let procs = parse_ps(
            "9101 1 00:10 0.5 ttys001 claude\n9102 1 00:10 0.5 ttys002 pi\n9103 1 00:10 0.5 ttys003 opencode\n9104 1 00:10 0.5 ttys004 codex\n9105 1 00:10 0.5 ttys005 gemini\n9106 1 00:10 0.5 ttys006 aider\n9107 1 00:10 0.5 ttys007 cursor-agent chat\n9108 1 00:10 0.5 ttys008 /opt/homebrew/bin/goose session\n9109 1 00:10 0.5 ttys009 /opt/homebrew/bin/amp threads\n9110 1 00:10 0.5 ttys010 /opt/homebrew/bin/crush\n9111 1 00:10 0.5 ttys011 qwen\n9112 1 00:10 0.5 ttys012 kimi\n9113 1 00:10 0.5 ttys013 /opt/homebrew/bin/droid\n9114 1 00:10 0.5 ttys014 copilot\n9115 1 00:10 0.5 ttys015 /opt/homebrew/bin/cline\n9116 1 00:10 0.5 ttys016 /opt/homebrew/bin/cn\n9117 1 00:10 0.5 ttys017 /opt/homebrew/bin/cody\n9118 9102 00:09 0.0 ttys002 node /usr/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js\n9119 9104 00:09 0.0 ttys004 node /usr/lib/node_modules/@openai/codex/cli.js\n9120 9101 00:09 0.0 ?? /Users/me/.local/bin/claude --chrome-native-host\n9121 1 00:09 0.0 ?? node /opt/tools/@modelcontextprotocol/server-filesystem/index.js\n9122 1 00:09 0.0 ?? agent-cli-lab agents --json\n9123 1 00:09 0.0 ttys018 codex --version\n",
        );
        let tail = |_: &str| -> Option<Tail> { None };
        let found = build(
            &procs,
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            &tail,
            &Me::default(),
        );
        let mut kinds: Vec<&str> = found.iter().filter_map(|r| r.kind.as_deref()).collect();
        kinds.sort_unstable();
        assert_eq!(
            kinds,
            vec![
                "aider",
                "amp",
                "claude",
                "cline",
                "codex",
                "cody",
                "continue",
                "copilot-cli",
                "crush",
                "cursor-agent",
                "droid",
                "gemini",
                "goose",
                "kimi",
                "opencode",
                "pi",
                "qwen"
            ]
        );
        assert_eq!(found.len(), 17, "{found:#?}");
        assert!(
            found
                .iter()
                .any(|r| r.pid == Some(9102) && r.tty.as_deref() == Some("ttys002"))
        );
        assert!(
            !found
                .iter()
                .any(|r| r.pid == Some(9118) || r.pid == Some(9119)),
            "same-kind children deduped"
        );
        assert!(
            !found
                .iter()
                .any(|r| (9120..=9123).contains(&r.pid.unwrap_or_default())),
            "false positives excluded"
        );
    }

    #[test]
    fn kind_filter_matches_builtin_and_custom_kinds() {
        let mut rules = builtin_rules();
        rules.extend(parse_harness_rules(
            "[[harness]]\nkind = \"myagent\"\nexe_names = [\"myagent\"]\n",
        ));
        assert_eq!(
            detect_kind_with("myagent chat", &rules).as_deref(),
            Some("myagent")
        );
        assert_eq!(detect_kind_with("pi", &rules).as_deref(), Some("pi"));
        let tail = |_: &str| -> Option<Tail> { None };
        let procs = parse_ps("9201 1 00:10 0.5 ttys001 pi\n9202 1 00:10 0.5 ttys002 opencode\n");
        let mut found = build(
            &procs,
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            &tail,
            &Me::default(),
        );
        found.retain(|agent| agent.kind.as_deref() == Some("opencode"));
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].pid, Some(9202));
        let mut custom = vec![AgentRec {
            kind: Some("myagent".into()),
            ..AgentRec::default()
        }];
        custom.retain(|agent| agent.kind.as_deref() == Some("myagent"));
        assert_eq!(custom.len(), 1);
        custom.retain(|agent| agent.kind.as_deref() == Some("nosuchagent"));
        assert!(custom.is_empty());
    }
}

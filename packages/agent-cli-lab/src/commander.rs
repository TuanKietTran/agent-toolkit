use std::{env, fs, path::PathBuf, process::{Command, Stdio}, thread, time::Duration};

use anyhow::{Context, Result, anyhow};
use clap::Args;
use regex::Regex;
use std::sync::OnceLock;
use serde::{Deserialize, Serialize};

#[derive(Debug, Args)]
pub(crate) struct SpawnArgs {
    name: String,
    #[arg(long, value_parser = ["sh", "pi", "claude", "codex"], required = true)]
    agent: String,
    #[arg(long)]
    model: Option<String>,
    #[arg(long, default_value = ".")]
    cwd: PathBuf,
    #[arg(long, default_value_t = 140)]
    cols: u16,
    #[arg(long, default_value_t = 45)]
    rows: u16,
    #[arg(long, default_value_t = 4)]
    boot: u64,
    #[arg(long)]
    no_open: bool,
    #[arg(last = true)]
    extra: Vec<String>,
}

#[derive(Debug, Args)]
pub(crate) struct NoteArgs {
    name: String,
    #[arg(required = true)]
    note: Vec<String>,
}

#[derive(Debug, Args)]
pub(crate) struct LedgerArgs {
    #[arg(short = 'n', default_value_t = 30)]
    count: usize,
}

#[derive(Debug, Args)]
pub(crate) struct CloseArgs {
    name: Option<String>,
    #[arg(long)]
    all: bool,
}

#[derive(Debug, Args)]
pub(crate) struct ResumeArgs {
    name: String,
    #[arg(long, default_value_t = 8)]
    last: usize,
}

#[derive(Debug, Serialize, Deserialize)]
struct Lab {
    name: String,
    agent: String,
    model: Option<String>,
    cwd: String,
    socket: String,
    pid: u32,
    record: String,
    last_prompt: Option<String>,
}

fn home() -> PathBuf {
    env::var_os("LABCTL_HOME").map(PathBuf::from)
        .or_else(|| env::var_os("HOME").map(|h| PathBuf::from(h).join(".lab-commander")))
        .unwrap_or_else(|| PathBuf::from(".lab-commander"))
}
fn labs() -> PathBuf { home().join("labs") }
fn record_path(name: &str) -> PathBuf { labs().join(format!("{name}.json")) }
fn load(name: &str) -> Result<Lab> {
    let path = record_path(name);
    serde_json::from_slice(&fs::read(&path).with_context(|| format!("no lab named {name:?}"))?)
        .context("invalid lab record")
}

pub(crate) fn spawn(a: SpawnArgs) -> Result<i32> {
    let cwd = a.cwd.canonicalize().context("cwd does not exist or is not a directory")?;
    fs::create_dir_all(labs())?;
    let path = record_path(&a.name);
    if path.exists() && load(&a.name).is_ok_and(|r| is_alive(r.pid)) { return Err(anyhow!("{} already running", a.name)); }
    let mut cmd = match a.agent.as_str() { "sh" => vec!["sh".to_owned()], "pi" => vec!["pi".to_owned()], "claude" => vec!["claude".to_owned()], "codex" => vec!["codex".to_owned()], _ => unreachable!() };
    if let Some(model) = &a.model { if a.agent == "claude" || a.agent == "codex" { cmd.extend(["--model".into(), model.clone()]); } }
    cmd.extend(a.extra);
    let exe = env::var_os("AGENT_CLI_LAB").unwrap_or_else(|| "agent-cli-lab".into());
    let socket = env::temp_dir().join(format!("{}.sock", a.name));
    let recfile = home().join(format!("{}.jsonl", a.name));
    let stderr = fs::File::create(home().join(format!("{}.stderr.log", a.name)))?;
    let host = Command::new(exe).args(["host", "-s"]).arg(&socket).args(["-r"]).arg(&recfile)
        .args(["-C", &a.cols.to_string(), "-R", &a.rows.to_string(), "--"]).args(&cmd)
        .current_dir(&cwd).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::from(stderr)).spawn().context("failed to start host")?;
    thread::sleep(Duration::from_secs(a.boot));
    if !socket.exists() { return Err(anyhow!("host failed to create socket {}", socket.display())); }
    let lab = Lab { name: a.name.clone(), agent: a.agent, model: a.model, cwd: cwd.display().to_string(), socket: socket.display().to_string(), pid: host.id(), record: recfile.display().to_string(), last_prompt: None };
    fs::write(path, serde_json::to_vec_pretty(&lab)?)?;
    if !a.no_open { let _ = Command::new(env::var_os("AGENT_CLI_LAB").unwrap_or_else(|| "agent-cli-lab".into())).args(["foreground", "-s"]).arg(&socket).spawn(); }
    println!("{} up (pid {}, socket {})", lab.name, lab.pid, lab.socket);
    Ok(0)
}

pub(crate) fn status(name: &str) -> Result<i32> {
    let lab = load(name)?;
    if !is_alive(lab.pid) { println!("{name:16} {:7} dead", lab.agent); return Ok(0); }
    let exe = binary();
    let screen = Command::new(exe).args(["screen", "-s"]).arg(&lab.socket).output()?;
    let relevant = after_last_prompt(&String::from_utf8_lossy(&screen.stdout), lab.last_prompt.as_deref());
    if let Some(caps) = marker_regex().captures(&relevant) { println!("{name:16} {:7} {} {}", lab.agent, caps.get(1).unwrap().as_str().to_lowercase(), caps.get(0).unwrap().as_str().trim()); }
    else { println!("{name:16} {:7} working", lab.agent); }
    Ok(0)
}
fn binary() -> std::ffi::OsString { env::var_os("AGENT_CLI_LAB").unwrap_or_else(|| "agent-cli-lab".into()) }
fn marker_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?m)^\s*LAB-(DONE|BLOCKED|CHECKPOINT)[ \t]+\S").unwrap())
}
fn after_last_prompt(screen: &str, prompt: Option<&str>) -> String {
    match prompt.filter(|p| !p.is_empty()).and_then(|p| screen.rfind(p).map(|at| at + p.len())) {
        Some(at) => screen[at..].to_owned(),
        None => String::new(),
    }
}
fn is_alive(pid: u32) -> bool { #[cfg(unix)] { PathBuf::from(format!("/proc/{pid}")).exists() || Command::new("kill").args(["-0", &pid.to_string()]).status().is_ok_and(|s| s.success()) } #[cfg(not(unix))] { let _ = pid; true } }

pub(crate) fn wait(name: &str, timeout: u64, poll_ms: u64) -> Result<i32> {
    let deadline = std::time::Instant::now() + Duration::from_secs(timeout);
    loop {
        let lab = load(name)?;
        if !is_alive(lab.pid) { println!("{name}: dead"); return Ok(2); }
        let output = Command::new(binary()).args(["screen", "-s"]).arg(&lab.socket).output()?;
        let relevant = after_last_prompt(&String::from_utf8_lossy(&output.stdout), lab.last_prompt.as_deref());
        if let Some(caps) = marker_regex().captures(&relevant) { let kind = caps.get(1).unwrap().as_str(); println!("{name}: {}", caps.get(0).unwrap().as_str().trim()); return Ok(if kind == "DONE" { 0 } else { 2 }); }
        if std::time::Instant::now() >= deadline { println!("{name}: timeout"); return Ok(3); }
        thread::sleep(Duration::from_millis(poll_ms.max(1)));
    }
}
pub(crate) fn ask(name: &str, text: &str) -> Result<i32> {
    let mut lab = load(name)?; lab.last_prompt = Some(text.to_owned()); fs::write(record_path(name), serde_json::to_vec_pretty(&lab)?)?;
    let out = Command::new(binary()).args(["ask", "-s"]).arg(&lab.socket).arg(text).output()?;
    print!("{}", String::from_utf8_lossy(&out.stdout)); Ok(out.status.code().unwrap_or(1))
}
pub(crate) fn send(name: &str, text: &str, enter: bool) -> Result<i32> {
    let lab = load(name)?; let mut cmd = Command::new(binary()); cmd.args(["send", "-s"]).arg(&lab.socket);
    if enter { cmd.arg("-e"); } if !text.is_empty() { cmd.arg(text); }
    let out = cmd.output()?; print!("{}", String::from_utf8_lossy(&out.stdout)); Ok(out.status.code().unwrap_or(1))
}
pub(crate) fn screen(name: &str) -> Result<i32> {
    let lab = load(name)?; Ok(Command::new(binary()).args(["screen", "-s"]).arg(lab.socket).status()?.code().unwrap_or(1))
}
pub(crate) fn checkpoint(a: NoteArgs) -> Result<i32> { append_ledger(serde_json::json!({"event":"checkpoint","lab":a.name,"note":a.note.join(" ")}))?; println!("recorded"); Ok(0) }
pub(crate) fn decide(a: NoteArgs) -> Result<i32> { append_ledger(serde_json::json!({"event":"decision","lab":a.name,"text":a.note.join(" ")}))?; println!("recorded"); Ok(0) }
fn append_ledger(mut row: serde_json::Value) -> Result<()> {
    use std::io::Write; fs::create_dir_all(home())?; row["t"] = serde_json::json!(format!("{:?}", std::time::SystemTime::now()));
    let mut f = fs::OpenOptions::new().create(true).append(true).open(home().join("ledger.jsonl"))?; serde_json::to_writer(&mut f, &row)?; writeln!(f)?; Ok(())
}
pub(crate) fn ledger(a: LedgerArgs) -> Result<i32> {
    let path = home().join("ledger.jsonl"); if path.exists() { let text = fs::read_to_string(path)?; let lines: Vec<_> = text.lines().collect(); for line in lines.iter().rev().take(a.count).rev() { println!("{line}"); } } Ok(0)
}
pub(crate) fn resume(a: ResumeArgs) -> Result<i32> {
    let mut lab = load(&a.name)?; let ledger = home().join("ledger.jsonl"); let mut notes = Vec::new();
    if ledger.exists() { for line in fs::read_to_string(ledger)?.lines() { let row: serde_json::Value = serde_json::from_str(line)?; if row["lab"] == a.name && (row["event"] == "checkpoint" || row["event"] == "decision") { notes.push(row["note"].as_str().or(row["text"].as_str()).unwrap_or("").to_owned()); } } }
    let prompt = format!("Resume from ledger (oldest first):\n{}\nContinue without redoing finished steps. End with LAB-DONE or LAB-BLOCKED <reason>.", notes.iter().rev().take(a.last).rev().cloned().collect::<Vec<_>>().join("\n"));
    lab.last_prompt = Some(prompt.clone()); fs::write(record_path(&a.name), serde_json::to_vec_pretty(&lab)?)?;
    Ok(Command::new(binary()).args(["ask", "-s"]).arg(lab.socket).arg(prompt).status()?.code().unwrap_or(1))
}
pub(crate) fn close(a: CloseArgs) -> Result<i32> {
    let mut names = if a.all { fs::read_dir(labs())?.filter_map(|e| e.ok()).filter_map(|e| e.path().file_stem().map(|s| s.to_string_lossy().into_owned())).collect::<Vec<_>>() } else { vec![a.name.context("provide a lab name or --all")?] };
    names.sort(); for name in names { let lab = load(&name)?; #[cfg(unix)] { let _ = Command::new("kill").args(["-TERM", &lab.pid.to_string()]).status(); } let _ = fs::remove_file(&lab.socket); fs::remove_file(record_path(&name))?; append_ledger(serde_json::json!({"event":"close","lab":name}))?; println!("closed {name}"); } Ok(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn marker_requires_line_prefix_type_and_nonempty_payload() {
        let re = marker_regex();
        assert!(re.is_match(" LAB-DONE result"));
        assert!(re.is_match("\tLAB-BLOCKED reason"));
        assert!(re.is_match("LAB-CHECKPOINT x"));
        assert!(!re.is_match("prefix LAB-DONE result"));
        assert!(!re.is_match("LAB-DONE"));
    }
    #[test]
    fn stale_markers_before_latest_prompt_are_ignored() {
        let current = after_last_prompt("LAB-DONE old\nquestion\nLAB-CHECKPOINT new", Some("question"));
        assert_eq!(marker_regex().captures(&current).unwrap().get(1).unwrap().as_str(), "CHECKPOINT");
        assert!(after_last_prompt("LAB-DONE old", Some("missing")).is_empty());
    }
}

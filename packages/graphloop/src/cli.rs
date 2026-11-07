//! The `graphloop` command line. OWNER: gl-cli.
//!
//! check | plan | graph | up | down | runs | trace. Core functions take an already-built
//! `Plan`/`Resolved` plus a `LabRunner` trait object; the load -> pick -> plan wrappers
//! are thin and separate, so tests drive the cores with a hand-built plan and a fake lab.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use clap::{Args, Parser, Subcommand};
use serde_json::{Value, json};

use crate::diag::{Diagnostics, Severity};
use crate::manifest::{EdgeKind, Manifest, Node, PickInfo};
use crate::pick::{PickDecision, PickRequest, Picker, Resolved, Via};
use crate::plan::{OpenStep, Plan, PlanOpts};
use crate::spec::{Harness, RenderCtx, Spec, Team};

pub fn check_line(harnesses: usize, teams: usize) -> String {
    format!("ok: {harnesses} harnesses, {teams} teams")
}

pub fn parse_vars(items: &[String]) -> Result<BTreeMap<String, String>, String> {
    let mut out = BTreeMap::new();
    for item in items {
        let (name, value) = item.split_once('=').ok_or_else(|| format!("--var expects NAME=VALUE, got {item:?}"))?;
        if name.is_empty() { return Err(format!("--var expects a non-empty NAME, got {item:?}")); }
        out.insert(name.to_string(), value.to_string());
    }
    Ok(out)
}

pub fn select_team<'a>(teams: &'a [Team], name: Option<&str>) -> Result<&'a Team, String> {
    let names = teams.iter().map(|t| t.name.as_str()).collect::<Vec<_>>().join(", ");
    match name {
        Some(want) => teams.iter().find(|t| t.name == want).ok_or_else(|| format!("unknown team {want:?} (teams: {names})")),
        None => match teams {
            [only] => Ok(only),
            [] => Err("no teams defined".to_string()),
            _ => Err(format!("multiple teams defined ({names}); pass --team")),
        },
    }
}

pub fn resolved_for<'a>(resolved: &'a [Resolved], harness: &str) -> Option<&'a Resolved> {
    resolved.iter().find(|r| r.harness == harness)
}

fn provenance_long(r: &Resolved) -> String {
    let base = match r.via {
        Via::SystemOne => r.rule.as_ref().map(|rule| format!("via system-one {rule}")).unwrap_or_else(|| "via system-one".to_string()),
        Via::Fallback => r.rule.as_ref().map(|rule| format!("via fallback {rule}")).unwrap_or_else(|| "via fallback".to_string()),
        Via::Pinned => "pinned".to_string(),
    };
    if r.reason.is_empty() { base } else { format!("{base}: {}", r.reason) }
}

fn provenance_short(r: &Resolved) -> String {
    match r.via {
        Via::SystemOne => r.rule.as_ref().map(|rule| format!("system-one {rule}")).unwrap_or_else(|| "system-one".to_string()),
        Via::Fallback => r.rule.as_ref().map(|rule| format!("fallback {rule}")).unwrap_or_else(|| "fallback".to_string()),
        Via::Pinned => "pinned".to_string(),
    }
}

pub fn shell_quote(word: &str) -> String {
    let safe = !word.is_empty() && word.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.' | '/' | ':' | '=' | ',' | '+' | '%' | '@' | '$' | '{' | '}'));
    if safe { word.to_string() } else { format!("'{}'", word.replace('\'', "'\\''")) }
}

pub fn shell_line(step: &OpenStep) -> String {
    let mut out = String::from("agent-cli-lab");
    for arg in &step.argv { out.push(' '); out.push_str(&shell_quote(&arg.display())); }
    out
}

pub fn render_diags(diags: &Diagnostics) -> String {
    let mut out = String::new();
    for d in &diags.0 {
        let sev = match d.severity { Severity::Error => "Error", Severity::Warning => "Warning" };
        out.push_str(&format!("{sev}: {}\n\n  on {} line {}", d.summary, d.file, d.line));
        if let Some(ctx) = &d.context { out.push_str(&format!(", in {ctx}")); }
        out.push_str(&format!(":\n\n{}\n", d.detail));
        if let Some(hint) = &d.hint { out.push_str(&format!("\n{hint}\n")); }
        out.push('\n');
    }
    out
}

pub fn plan_output(plan: &Plan, resolved: &[Resolved]) -> String {
    let mut out = String::new();
    for step in &plan.steps {
        match resolved_for(resolved, &step.harness) {
            Some(r) => out.push_str(&format!("# harness {}: {} ({})\n", step.harness, step.model, provenance_long(r))),
            None => out.push_str(&format!("# harness {}: {}\n", step.harness, step.model)),
        }
        out.push_str(&shell_line(step));
        out.push('\n');
    }
    out
}

pub fn plan_json(plan: &Plan, resolved: &[Resolved]) -> Value {
    let steps: Vec<Value> = plan.steps.iter().map(|step| {
        let r = resolved_for(resolved, &step.harness);
        json!({"harness": step.harness, "name": step.name, "role": step.role, "parent": step.parent, "model": step.model, "via": r.map(|x| x.via.as_str()), "rule": r.and_then(|x| x.rule.clone()), "reason": r.map(|x| x.reason.clone()), "argv": step.argv.iter().map(|t| t.display()).collect::<Vec<_>>()})
    }).collect();
    json!({"team": plan.team, "root": plan.root, "steps": steps, "edges": plan.edges})
}

fn node_line(step: &OpenStep, resolved: &[Resolved]) -> String {
    match resolved_for(resolved, &step.harness) {
        Some(r) => format!("{}  [{}]  {}  ({})", step.name, step.role, r.display_model(), provenance_short(r)),
        None => format!("{}  [{}]  {}  (pinned)", step.name, step.role, step.model),
    }
}

fn append_children(out: &mut String, plan: &Plan, resolved: &[Resolved], parent: &str, prefix: &str, visited: &mut HashSet<String>) {
    let kids: Vec<&OpenStep> = plan.steps.iter().filter(|s| s.parent.as_deref() == Some(parent) && !visited.contains(&s.name)).collect();
    for (i, kid) in kids.iter().enumerate() {
        let last = i + 1 == kids.len();
        visited.insert(kid.name.clone());
        out.push_str(prefix);
        out.push_str(if last { "\u{2514}\u{2500}\u{25b6} " } else { "\u{251c}\u{2500}\u{25b6} " });
        out.push_str(&node_line(kid, resolved));
        out.push('\n');
        let next = format!("{}{}", prefix, if last { "    " } else { "\u{2502}   " });
        append_children(out, plan, resolved, &kid.name, &next, visited);
    }
}

pub fn graph_output(team: &Team, plan: &Plan, resolved: &[Resolved]) -> String {
    let root_step = plan.steps.iter().find(|s| s.name == plan.root);
    let root_label = root_step.map(|s| s.harness.clone()).unwrap_or_else(|| plan.root.clone());
    let mut out = format!("team {} (root {})\n", team.name, root_label);
    let mut visited: HashSet<String> = HashSet::new();
    if let Some(root) = root_step {
        visited.insert(root.name.clone());
        out.push_str(&node_line(root, resolved));
        out.push('\n');
        let root_name = root.name.clone();
        append_children(&mut out, plan, resolved, &root_name, "", &mut visited);
    }
    for step in &plan.steps {
        if !visited.contains(&step.name) {
            visited.insert(step.name.clone());
            out.push_str(&node_line(step, resolved));
            out.push('\n');
            let name = step.name.clone();
            append_children(&mut out, plan, resolved, &name, "", &mut visited);
        }
    }
    let member: Vec<_> = plan.edges.iter().filter(|e| e.kind == EdgeKind::Member).collect();
    if !member.is_empty() {
        out.push_str("member edges:\n");
        for e in member { out.push_str(&format!("{} -> {} (member)\n", e.from, e.to)); }
    }
    out
}

pub fn parse_list_names(text: &str) -> Result<HashSet<String>, String> {
    let value: Value = serde_json::from_str(text).map_err(|e| format!("agent-cli-lab list --json: invalid JSON: {e}"))?;
    let items: Vec<Value> = match value {
        Value::Array(a) => a,
        Value::Object(o) => ["sessions", "entries", "items", "labs"].iter().find_map(|k| o.get(*k).and_then(Value::as_array).cloned()).ok_or_else(|| "agent-cli-lab list --json: unexpected shape".to_string())?,
        _ => return Err("agent-cli-lab list --json: unexpected shape".to_string()),
    };
    Ok(items.iter().filter_map(|it| match it { Value::String(s) => Some(s.clone()), Value::Object(o) => o.get("name").and_then(Value::as_str).map(str::to_string), _ => None }).collect())
}

pub trait LabRunner {
    fn list_names(&self) -> Result<HashSet<String>, String>;
    fn open(&self, argv: &[String], log_path: &Path) -> Result<(), String>;
    fn stop(&self, name: &str) -> Result<(), String>;
    fn console_snapshot(&self) -> Result<String, String>;
}

#[derive(Debug, Clone)]
pub struct ProcessRunner { pub bin: PathBuf }

impl ProcessRunner {
    pub fn from_env() -> Self {
        let bin = std::env::var_os("AGENT_CLI_LAB_BIN").filter(|v| !v.is_empty()).map(PathBuf::from).unwrap_or_else(|| PathBuf::from("agent-cli-lab"));
        ProcessRunner { bin }
    }
    fn run_capture(&self, args: &[&str]) -> Result<String, String> {
        let out = std::process::Command::new(&self.bin).args(args).output().map_err(|e| format!("run {}: {e}", self.bin.display()))?;
        if out.status.success() { Ok(String::from_utf8_lossy(&out.stdout).into_owned()) } else { Err(format!("{} {} failed ({})", self.bin.display(), args.join(" "), out.status)) }
    }
}

impl LabRunner for ProcessRunner {
    fn list_names(&self) -> Result<HashSet<String>, String> { parse_list_names(&self.run_capture(&["list", "--json"])?) }
    fn open(&self, argv: &[String], log_path: &Path) -> Result<(), String> {
        let file = std::fs::File::create(log_path).map_err(|e| format!("create {}: {e}", log_path.display()))?;
        let file_err = file.try_clone().map_err(|e| format!("clone {}: {e}", log_path.display()))?;
        let status = std::process::Command::new(&self.bin).args(argv).stdout(std::process::Stdio::from(file)).stderr(std::process::Stdio::from(file_err)).status().map_err(|e| format!("run {}: {e}", self.bin.display()))?;
        if status.success() { Ok(()) } else { Err(format!("agent-cli-lab open failed ({status}); see {}", log_path.display())) }
    }
    fn stop(&self, name: &str) -> Result<(), String> { self.run_capture(&["stop", "-n", name]).map(|_| ()) }
    fn console_snapshot(&self) -> Result<String, String> { self.run_capture(&["console", "--snapshot", "--view", "graph", "--width", "140", "--height", "34"]) }
}

pub fn build_nodes(harnesses: &[Harness], plan: &Plan, resolved: &[Resolved]) -> Result<Vec<Node>, String> {
    plan.steps.iter().map(|step| {
        let r = resolved_for(resolved, &step.harness).ok_or_else(|| format!("no model resolved for harness {}", step.harness))?;
        let tools = harnesses.iter().find(|h| h.name == step.harness).map(|h| h.tools.clone()).unwrap_or_default();
        Ok(Node { name: step.name.clone(), harness: step.harness.clone(), role: step.role.clone(), parent: step.parent.clone(), requested_model: r.requested.clone(), model: r.display_model(), model_label: r.label.clone(), pick: PickInfo { via: r.via.as_str().to_string(), rule: r.rule.clone(), reason: r.reason.clone(), degraded_level: r.degraded_level }, tools })
    }).collect()
}

pub fn build_manifest(plan: &Plan, nodes: Vec<Node>, source: &str, run: &str, trace_dir: &Path, now_ms: u64) -> Manifest {
    Manifest { version: crate::manifest::VERSION, run: run.to_string(), team: plan.team.clone(), source: source.to_string(), root: plan.root.clone(), created_ms: now_ms, trace_dir: Some(trace_dir.display().to_string()), nodes, edges: plan.edges.clone() }
}

pub fn write_manifest_to(manifest: &Manifest, dir: &Path) -> Result<PathBuf, String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    let path = dir.join(format!("{}.json", manifest.run));
    let tmp = dir.join(format!(".{}.tmp", manifest.run));
    let bytes = serde_json::to_vec_pretty(manifest).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, bytes).map_err(|e| format!("write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("rename to {}: {e}", path.display()))?;
    Ok(path)
}

pub fn manifest_for_source<'a>(manifests: &'a [Manifest], source: &str) -> Option<&'a Manifest> {
    manifests.iter().filter(|m| m.source == source).max_by_key(|m| m.created_ms)
}

pub struct UpRequest<'a> {
    pub plan: &'a Plan,
    pub nodes: Vec<Node>,
    pub source: String,
    pub home: PathBuf,
    pub manifest_dir: PathBuf,
    pub run: String,
    pub now_ms: u64,
    pub env: &'a dyn Fn(&str) -> Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpOutcome { pub run: String, pub run_dir: PathBuf, pub manifest_path: PathBuf, pub output: String }

pub fn up_core(req: &UpRequest, runner: &dyn LabRunner) -> Result<UpOutcome, String> {
    let models: HashMap<String, String> = req.nodes.iter().map(|n| (n.harness.clone(), n.model.clone())).collect();
    let model_fn = |h: &str| models.get(h).cloned();
    let mut rendered: Vec<Vec<String>> = Vec::new();
    for step in &req.plan.steps {
        let ctx = RenderCtx { env: req.env, model: &model_fn };
        let mut argv = Vec::new();
        for t in &step.argv { argv.push(t.render(&ctx).map_err(|e| format!("harness {}: {e}", step.harness))?); }
        rendered.push(argv);
    }
    let live = runner.list_names()?;
    for step in &req.plan.steps {
        if live.contains(&step.name) { return Err(format!("session {} is already running; stop it first or pass --prefix", step.name)); }
    }
    let run_dir = req.home.join("runs").join(&req.run);
    let trace_dir = run_dir.join("trace");
    std::fs::create_dir_all(&trace_dir).map_err(|e| format!("create {}: {e}", trace_dir.display()))?;
    let manifest = build_manifest(req.plan, req.nodes.clone(), &req.source, &req.run, &trace_dir, req.now_ms);
    let manifest_path = write_manifest_to(&manifest, &req.manifest_dir)?;
    let mut opened: Vec<String> = Vec::new();
    for (step, argv) in req.plan.steps.iter().zip(rendered.iter()) {
        let log_path = run_dir.join(format!("open-{}.log", step.name));
        match runner.open(argv, &log_path) {
            Ok(()) => { let _ = std::fs::remove_file(&log_path); opened.push(step.name.clone()); }
            Err(e) => {
                for name in opened.iter().rev() { let _ = runner.stop(name); }
                let _ = std::fs::remove_file(&manifest_path);
                let _ = std::fs::write(run_dir.join("error.log"), format!("open {} failed: {e}\n", step.name));
                return Err(format!("open failed for {}: {e}", step.name));
            }
        }
    }
    let run_json = run_dir.join("run.json");
    std::fs::copy(&manifest_path, &run_json).map_err(|e| format!("copy manifest to {}: {e}", run_json.display()))?;
    let mut output = format!("up: {} ({} labs)\n", req.run, req.plan.steps.len());
    if let Ok(snap) = runner.console_snapshot() {
        let snap = snap.trim_end();
        if !snap.is_empty() { output.push_str(snap); output.push('\n'); }
    }
    output.push_str(&format!("watch it live: agent-cli-lab console\nclose it: graphloop down --run {}\n", req.run));
    Ok(UpOutcome { run: req.run.clone(), run_dir, manifest_path, output })
}

pub fn down_core(manifest: &Manifest, runner: &dyn LabRunner, manifest_dir: &Path, home: &Path, purge: bool) -> Result<String, String> {
    let mut lines: Vec<String> = Vec::new();
    for node in manifest.nodes.iter().rev() {
        match runner.stop(&node.name) { Ok(()) => lines.push(format!("stopped {}", node.name)), Err(_) => lines.push(format!("already gone: {}", node.name)) }
    }
    let path = manifest_dir.join(format!("{}.json", manifest.run));
    match std::fs::remove_file(&path) { Ok(()) => {}, Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}, Err(e) => return Err(format!("remove {}: {e}", path.display())) }
    let run_dir = home.join("runs").join(&manifest.run);
    if purge {
        if run_dir.exists() { std::fs::remove_dir_all(&run_dir).map_err(|e| format!("remove {}: {e}", run_dir.display()))?; }
        lines.push(format!("purged {}", manifest.run));
    }
    Ok(lines.join("\n") + "\n")
}

pub fn format_age(age_ms: u64) -> String {
    let s = age_ms / 1000;
    if s < 60 { format!("{s}s") } else if s < 3600 { format!("{}m", s / 60) } else if s < 86_400 { format!("{}h", s / 3600) } else { format!("{}d", s / 86_400) }
}

pub fn runs_output(manifests: &[Manifest], live: &HashSet<String>, now_ms: u64) -> String {
    if manifests.is_empty() { return "no runs\n".to_string(); }
    let mut out = String::from("run  team  nodes  age\n");
    for m in manifests {
        let live_n = m.nodes.iter().filter(|n| live.contains(&n.name)).count();
        out.push_str(&format!("{}  {}  {}/{}  {}\n", m.run, m.team, live_n, m.nodes.len(), format_age(now_ms.saturating_sub(m.created_ms))));
    }
    out
}

pub fn trace_output(manifest: &Manifest) -> Result<String, String> {
    let trace_dir = manifest.trace_dir.as_deref().ok_or_else(|| format!("run {} has no trace directory", manifest.run))?;
    let dir = Path::new(trace_dir);
    if !dir.is_dir() { return Err(format!("trace directory {} does not exist", dir.display())); }
    let mut files: Vec<PathBuf> = std::fs::read_dir(dir).map_err(|e| format!("read {}: {e}", dir.display()))?.flatten().map(|e| e.path()).filter(|p| p.is_file()).collect();
    files.sort();
    let mut out = format!("run {} trace {}\n", manifest.run, dir.display());
    if files.is_empty() { out.push_str("no recordings\n"); return Ok(out); }
    for f in &files {
        let size = std::fs::metadata(f).map(|m| m.len()).unwrap_or(0);
        let stem = f.file_stem().and_then(|s| s.to_str()).unwrap_or("");
        let node = manifest.nodes.iter().find(|n| n.name == stem).map(|n| n.name.clone()).unwrap_or_else(|| "-".to_string());
        let name = f.file_name().and_then(|s| s.to_str()).unwrap_or("");
        out.push_str(&format!("{name}  {size} bytes  {node}\n"));
    }
    Ok(out)
}

fn err(msg: &str) -> String { format!("graphloop: {msg}") }

fn now_ms() -> u64 { SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0) }

fn graphloop_home() -> PathBuf {
    if let Some(home) = std::env::var_os("GRAPHLOOP_HOME").filter(|v| !v.is_empty()) { return PathBuf::from(home); }
    if let Some(home) = std::env::var_os("HOME").filter(|v| !v.is_empty()) { return PathBuf::from(home).join(".agent-cli-lab"); }
    PathBuf::from(".agent-cli-lab")
}

fn new_run_id(team: &str) -> String {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    format!("{team}-{}-{:04x}", now.as_secs(), (std::process::id() ^ now.subsec_nanos()) & 0xffff)
}

fn load_spec(file: &Path, vars: &[String]) -> Result<Spec, String> {
    if !file.is_file() { return Err(format!("cannot read {}: no such file", file.display())); }
    let overrides = parse_vars(vars).map_err(|e| err(&e))?;
    crate::load::load_file(file, &overrides).map_err(|e| format!("{e:#}"))
}

struct FailPicker;
impl Picker for FailPicker {
    fn pick(&self, _request: &PickRequest) -> anyhow::Result<PickDecision> { anyhow::bail!("system-one is not available") }
}

fn build_picker(spec: &Spec) -> Box<dyn Picker> {
    match crate::pick::locate_system_one() {
        Some(dir) => Box::new(crate::pick::SystemOnePicker { python: std::env::var("GRAPHLOOP_PYTHON").ok().filter(|v| !v.is_empty()).unwrap_or_else(|| "python3".to_string()), system_one_dir: dir, student: spec.system_one.as_ref().and_then(|s| s.student.as_ref()).map(PathBuf::from), timeout_ms: 10_000 }),
        None => Box::new(FailPicker),
    }
}

fn load_and_resolve(args: &FileArgs) -> Result<(Spec, Team, Vec<Resolved>), String> {
    let spec = load_spec(&args.file, &args.var)?;
    let team = select_team(&spec.teams, args.team.as_deref()).map_err(|e| err(&e))?.clone();
    let picker = build_picker(&spec);
    let resolved = crate::pick::resolve_all(&spec, picker.as_ref()).map_err(|d| render_diags(&d))?;
    Ok((spec, team, resolved))
}

fn build_plan(spec: &Spec, team: &Team, resolved: &[Resolved], opts: PlanOpts) -> Result<Plan, String> {
    crate::plan::build(spec, &team.name, resolved, &opts).map_err(|d| render_diags(&d))
}

fn absolute_string(path: &Path) -> String {
    std::fs::canonicalize(path).map(|p| p.display().to_string()).unwrap_or_else(|_| path.display().to_string())
}

#[derive(Parser, Debug)]
#[command(name = "graphloop", version, about = "Bring a Graphspec (.yah) team up as agent-cli-lab labs")]
struct Cli { #[command(subcommand)] command: Cmd }

#[derive(Args, Debug)]
struct FileArgs {
    /// Path to a .yah (Graphspec) file
    file: PathBuf,
    /// Team to use (default: the only team in the file)
    #[arg(long)]
    team: Option<String>,
    /// Prefix every session name with PREFIX-
    #[arg(long)]
    prefix: Option<String>,
    /// Override a variable, NAME=VALUE (repeatable)
    #[arg(long = "var", value_name = "NAME=VALUE")]
    var: Vec<String>,
    /// Open every lab detached
    #[arg(long)]
    detached: bool,
}

#[derive(Subcommand, Debug)]
enum Cmd {
    /// Validate a .yah file
    Check { #[command(flatten)] args: FileArgs },
    /// Print the agent-cli-lab open commands for a team
    Plan { #[command(flatten)] args: FileArgs, /// Emit one JSON document instead of text
        #[arg(long)] json: bool },
    /// Print the team graph as a tree
    Graph { #[command(flatten)] args: FileArgs },
    /// Open every lab in a team and write a run manifest
    Up { #[command(flatten)] args: FileArgs },
    /// Stop every lab in a run (by .yah FILE or --run RUN)
    Down { /// The .yah file the run was opened from
        file: Option<PathBuf>, /// Run id, as printed by `graphloop up`
        #[arg(long)] run: Option<String>, /// Also delete the run directory, including its traces
        #[arg(long)] purge: bool },
    /// List known runs
    Runs,
    /// List the recordings in a run's trace directory
    Trace { /// Run id, as printed by `graphloop up`
        run: String },
}

fn dispatch(cli: Cli) -> Result<String, String> {
    match cli.command {
        Cmd::Check { args } => { let spec = load_spec(&args.file, &args.var)?; Ok(format!("{}\n", check_line(spec.harnesses.len(), spec.teams.len()))) }
        Cmd::Plan { args, json } => {
            let (spec, team, resolved) = load_and_resolve(&args)?;
            let opts = PlanOpts { prefix: args.prefix.clone(), run: String::new(), trace_dir: None, detached: args.detached };
            let plan = build_plan(&spec, &team, &resolved, opts)?;
            if json { serde_json::to_string_pretty(&plan_json(&plan, &resolved)).map(|s| s + "\n").map_err(|e| err(&e.to_string())) } else { Ok(plan_output(&plan, &resolved)) }
        }
        Cmd::Graph { args } => {
            let (spec, team, resolved) = load_and_resolve(&args)?;
            let opts = PlanOpts { prefix: args.prefix.clone(), run: String::new(), trace_dir: None, detached: args.detached };
            let plan = build_plan(&spec, &team, &resolved, opts)?;
            Ok(graph_output(&team, &plan, &resolved))
        }
        Cmd::Up { args } => {
            let (spec, team, resolved) = load_and_resolve(&args)?;
            let home = graphloop_home();
            let run = new_run_id(&team.name);
            let trace_dir = home.join("runs").join(&run).join("trace");
            let opts = PlanOpts { prefix: args.prefix.clone(), run: run.clone(), trace_dir: Some(trace_dir), detached: args.detached };
            let plan = build_plan(&spec, &team, &resolved, opts)?;
            let nodes = build_nodes(&spec.harnesses, &plan, &resolved).map_err(|e| err(&e))?;
            let runner = ProcessRunner::from_env();
            let env_fn = |name: &str| std::env::var(name).ok();
            let req = UpRequest { plan: &plan, nodes, source: absolute_string(&args.file), home, manifest_dir: crate::manifest::dir(), run, now_ms: now_ms(), env: &env_fn };
            up_core(&req, &runner).map(|o| o.output).map_err(|e| err(&e))
        }
        Cmd::Down { file, run, purge } => {
            let manifests = Manifest::list();
            let manifest = match (&run, &file) {
                (Some(r), _) => manifests.iter().find(|m| &m.run == r).cloned().ok_or_else(|| err(&format!("unknown run {r}")))?,
                (None, Some(f)) => { let source = absolute_string(f); manifest_for_source(&manifests, &source).cloned().ok_or_else(|| err(&format!("no run found for {source}")))? }
                (None, None) => return Err(err("down needs a FILE or --run RUN")),
            };
            let runner = ProcessRunner::from_env();
            down_core(&manifest, &runner, &crate::manifest::dir(), &graphloop_home(), purge).map_err(|e| err(&e))
        }
        Cmd::Runs => { let manifests = Manifest::list(); let live = ProcessRunner::from_env().list_names().unwrap_or_default(); Ok(runs_output(&manifests, &live, now_ms())) }
        Cmd::Trace { run } => { let manifests = Manifest::list(); let manifest = manifests.iter().find(|m| m.run == run).ok_or_else(|| err(&format!("unknown run {run}")))?; trace_output(manifest).map_err(|e| err(&e)) }
    }
}

/// Process exit code: 0 ok, 1 error (2 is clap's usage error).
pub fn main() -> i32 {
    let cli = match Cli::try_parse() { Ok(c) => c, Err(e) => { let code = e.exit_code(); let _ = e.print(); return code; } };
    match dispatch(cli) {
        Ok(out) => { print!("{out}"); 0 }
        Err(msg) => { eprint!("{msg}"); if !msg.ends_with('\n') { eprintln!(); } 1 }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn team(name: &str) -> Team { Team { name: name.to_string(), root: "commander".to_string(), members: vec![], graph: true, line: 1 } }
    #[test] fn check_line_counts() { assert_eq!(check_line(2, 1), "ok: 2 harnesses, 1 teams"); }
    #[test] fn parse_vars_ok_and_bad() { let v = parse_vars(&["A=1".to_string(), "B=x=y".to_string()]).unwrap(); assert_eq!(v.get("B").unwrap(), "x=y"); assert!(parse_vars(&["A".to_string()]).is_err()); assert!(parse_vars(&["=1".to_string()]).is_err()); }
    #[test] fn select_team_cases() { let one = vec![team("default")]; assert_eq!(select_team(&one, None).unwrap().name, "default"); assert!(select_team(&one, Some("nope")).unwrap_err().contains("default")); let two = vec![team("a"), team("b")]; assert!(select_team(&two, None).unwrap_err().contains("a, b")); }
    #[test] fn shell_quote_cases() { assert_eq!(shell_quote("pi"), "pi"); assert_eq!(shell_quote("${env.X}"), "${env.X}"); assert_eq!(shell_quote("a b"), "'a b'"); assert_eq!(shell_quote(""), "''"); }
    #[test] fn format_age_units() { assert_eq!(format_age(5_000), "5s"); assert_eq!(format_age(180_000), "3m"); assert_eq!(format_age(7_200_000), "2h"); assert_eq!(format_age(172_800_000), "2d"); }
    #[test] fn parse_list_names_shapes() { let a = parse_list_names("[{\"name\":\"x\"}]").unwrap(); assert!(a.contains("x")); let b = parse_list_names("{\"sessions\":[\"z\"]}").unwrap(); assert!(b.contains("z")); assert!(parse_list_names("nope").is_err()); }
}

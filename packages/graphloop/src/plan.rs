//! Team -> `h1 open` commands and graph edges. OWNER: gl-plan.
//!
//! Orchestration rules 1 and 3 (docs/graphspec.md): every harness with `kind = "h1"` is
//! started by `h1 open -n NAME --role ROLE [--parent PARENT] --model <resolved> ...`;
//! the team block is the graph (nodes = harnesses; edges = parent relations plus `root -> member`
//! for a member that has no parent).

use std::collections::HashSet;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::ast::Span;
use crate::diag::{Diagnostic, Diagnostics};
use crate::manifest::{Edge, EdgeKind, Manifest, Node, PickInfo};
use crate::pick::Resolved;
use crate::spec::{Part, RenderCtx, Spec, Team, Templ};

#[derive(Debug, Clone, Default)]
pub struct PlanOpts {
    /// Prepended as `PREFIX-` to every session name (keeps teams from colliding).
    pub prefix: Option<String>,
    /// Run id, used for the manifest file name and the trace directory.
    pub run: String,
    /// When set, every open gets `--record <trace_dir>/<session name>.jsonl`.
    pub trace_dir: Option<PathBuf>,
    /// Force `--detached` on every open (no terminal windows).
    pub detached: bool,
}

/// One `h1 open` call.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenStep {
    pub harness: String,
    /// Session name (`-n`).
    pub name: String,
    pub role: String,
    /// Parent SESSION name, if any.
    pub parent: Option<String>,
    /// `provider/id`.
    pub model: String,
    /// Everything after the program name: `open -n NAME ... -- COMMAND...`. Late-bound `${env.*}`
    /// parts are still `Part::Env`; model references are already substituted.
    pub argv: Vec<Templ>,
}

impl OpenStep {
    /// Printable shell line with env parts shown as `${env.NAME}`. Never contains secret values.
    pub fn shell(&self) -> String {
        let mut out = String::from("h1");
        for arg in &self.argv {
            out.push(' ');
            out.push_str(&shell_quote(&arg.display()));
        }
        out
    }
    /// Fully expanded argv (without the program name) for launching.
    pub fn render(&self, ctx: &RenderCtx) -> Result<Vec<String>, String> {
        self.argv.iter().map(|arg| arg.render(ctx)).collect()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Plan {
    pub team: String,
    /// Session name of the root.
    pub root: String,
    /// Parents before children (topological, stable in declaration order).
    pub steps: Vec<OpenStep>,
    pub edges: Vec<Edge>,
}

/// Session name for a harness label: `PREFIX-label`, or the label itself without a prefix.
fn session_name(label: &str, prefix: Option<&str>) -> String {
    match prefix {
        Some(prefix) => format!("{prefix}-{label}"),
        None => label.to_owned(),
    }
}

fn error(spec: &Spec, line: u32, summary: impl Into<String>, detail: impl Into<String>) -> Diagnostic {
    Diagnostic::error(&spec.file, Span { line, col: 1 }, summary, detail)
}

/// Why a session name is invalid, or `None` when it is valid: 1..=40 chars of `[A-Za-z0-9._-]`,
/// not starting with `.`.
fn session_name_problem(name: &str) -> Option<String> {
    if name.is_empty() {
        return Some("it is empty".to_owned());
    }
    if name.chars().count() > 40 {
        return Some(format!("it is {} characters, over the 40 character limit", name.chars().count()));
    }
    if name.starts_with('.') {
        return Some("it starts with '.'".to_owned());
    }
    if let Some(c) = name.chars().find(|c| !(c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))) {
        return Some(format!("it contains the invalid character {c:?}; allowed characters are [A-Za-z0-9._-]"));
    }
    None
}

/// Push literal text onto `parts`, merging into a trailing literal so substituted templates stay
/// canonical (one `Lit` where the text is fully known).
fn push_lit(parts: &mut Vec<Part>, text: String) {
    if text.is_empty() {
        return;
    }
    if let Some(Part::Lit(prev)) = parts.last_mut() {
        prev.push_str(&text);
    } else {
        parts.push(Part::Lit(text));
    }
}

/// Replace every `${harnesses.X.model}` part with X's resolved `provider/id` NOW, and every `${harnesses.X.model_id}` part with X's bare resolved id. `Part::Env`
/// stays late-bound. Errors name the harness holding the reference and the unresolved harness.
fn substitute(templ: &Templ, resolved: &[Resolved], spec: &Spec, line: u32, owner: &str) -> Result<Templ, Diagnostics> {
    let mut parts: Vec<Part> = Vec::new();
    for part in &templ.0 {
        match part {
            Part::Lit(text) => push_lit(&mut parts, text.clone()),
            Part::Env(name) => parts.push(Part::Env(name.clone())),
            Part::Vault(v, k) => parts.push(Part::Vault(v.clone(), k.clone())),
            Part::HarnessModel(name) => {
                let Some(found) = resolved.iter().find(|r| &r.harness == name) else {
                    return Err(Diagnostics::one(error(
                        spec,
                        line,
                        "Unresolved harness model",
                        format!("harness {owner:?} references ${{harnesses.{name}.model}}, but no model was resolved for harness {name:?}"),
                    )));
                };
                push_lit(&mut parts, found.display_model());
            }
            Part::HarnessModelId(name) => {
                let Some(found) = resolved.iter().find(|r| &r.harness == name) else {
                    return Err(Diagnostics::one(error(
                        spec,
                        line,
                        "Unresolved harness model",
                        format!("harness {owner:?} references ${{harnesses.{name}.model_id}}, but no model was resolved for harness {name:?}"),
                    )));
                };
                push_lit(&mut parts, found.id.clone());
            }
        }
    }
    Ok(Templ(parts))
}

/// POSIX single-quote quoting, only where needed: safe tokens pass through untouched, everything
/// else is wrapped in single quotes with embedded quotes written as `'\''`. The empty string
/// becomes `''`.
fn shell_quote(text: &str) -> String {
    if text.is_empty() {
        return "''".to_owned();
    }
    let safe = text.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '/' | ':' | '=' | '@' | '%' | '+' | ','));
    if safe {
        text.to_owned()
    } else {
        format!("'{}'", text.replace('\'', "'\\''"))
    }
}

/// Parent edges first, then member edges (`root -> member` for parentless non-root members).
pub fn edges(spec: &Spec, team: &Team, prefix: Option<&str>) -> Vec<Edge> {
    let mut labels: Vec<&str> = vec![team.root.as_str()];
    for member in &team.members {
        if !labels.contains(&member.as_str()) {
            labels.push(member.as_str());
        }
    }
    let in_team = |name: &str| labels.contains(&name);
    let mut out = Vec::new();
    for harness in &spec.harnesses {
        if !in_team(&harness.name) {
            continue;
        }
        if let Some(parent) = &harness.parent && in_team(parent) {
            out.push(Edge { from: session_name(parent, prefix), to: session_name(&harness.name, prefix), kind: EdgeKind::Parent });
        }
    }
    for harness in &spec.harnesses {
        if harness.name == team.root || !team.members.iter().any(|m| m == &harness.name) {
            continue;
        }
        if harness.parent.is_none() {
            out.push(Edge { from: session_name(&team.root, prefix), to: session_name(&harness.name, prefix), kind: EdgeKind::Member });
        }
    }
    out
}

/// Validate the team (root and members exist, every ancestor is in the team, no parent cycle,
/// `kind == "h1"`, session names valid: `[A-Za-z0-9._-]`, at most 40 chars, not starting
/// with `.`) and build the plan. Errors are `Diagnostics` with `file:line` of the harness or team.
pub fn build(spec: &Spec, team: &str, resolved: &[Resolved], opts: &PlanOpts) -> Result<Plan, Diagnostics> {
    let Some(team_block) = spec.team(team) else {
        let defined = if spec.teams.is_empty() {
            "no teams are defined".to_owned()
        } else {
            format!("defined teams: {}", spec.teams.iter().map(|t| format!("{:?}", t.name)).collect::<Vec<_>>().join(", "))
        };
        return Err(Diagnostics::one(error(spec, 1, "Unknown team", format!("team {team:?} is not defined; {defined}"))));
    };

    // Nodes: root + members, de-duplicated.
    let mut labels: Vec<&str> = vec![team_block.root.as_str()];
    for member in &team_block.members {
        if !labels.contains(&member.as_str()) {
            labels.push(member.as_str());
        }
    }
    let in_team = |name: &str| labels.contains(&name);

    let mut diags = Diagnostics::default();
    if spec.harness(&team_block.root).is_none() {
        diags.push(error(spec, team_block.line, "Unknown harness", format!("team {team:?} root {:?} is not a harness", team_block.root)));
    }
    for member in &team_block.members {
        if spec.harness(member).is_none() {
            diags.push(error(spec, team_block.line, "Unknown harness", format!("team {team:?} member {member:?} is not a harness")));
        }
    }
    if !diags.is_empty() {
        return Err(diags);
    }

    // In declaration order of spec.harnesses.
    let nodes: Vec<&crate::spec::Harness> = spec.harnesses.iter().filter(|h| in_team(&h.name)).collect();
    let prefix = opts.prefix.as_deref();

    for harness in &nodes {
        if harness.kind != "h1" {
            diags.push(error(spec, harness.line, "Unsupported harness kind", format!("harness {:?} has kind {:?}; only \"h1\" is supported", harness.name, harness.kind)));
        }
        let name = session_name(&harness.name, prefix);
        if let Some(problem) = session_name_problem(&name) {
            diags.push(error(spec, harness.line, "Invalid session name", format!("session name {name:?} for harness {:?} is invalid: {problem} (limit: 1-40 characters of [A-Za-z0-9._-], not starting with '.')", harness.name)));
        }
        // Walk the ancestor chain: every ancestor must be in the team, and the chain must end.
        let mut path: Vec<&str> = vec![harness.name.as_str()];
        let mut current = *harness;
        while let Some(parent) = current.parent.as_deref() {
            if !in_team(parent) {
                diags.push(error(spec, harness.line, "Parent not in team", format!("harness {:?} has parent {parent:?} which is not in team {team:?}", harness.name)));
                break;
            }
            if path.contains(&parent) {
                let mut cycle = path.clone();
                cycle.push(parent);
                diags.push(error(spec, harness.line, "Parent cycle", format!("parent cycle detected for harness {:?}: {}", harness.name, cycle.join(" -> "))));
                break;
            }
            path.push(parent);
            let Some(parent_harness) = spec.harness(parent) else { break };
            current = parent_harness;
        }
        if !resolved.iter().any(|r| r.harness == harness.name) {
            diags.push(error(spec, harness.line, "Missing resolved model", format!("no model was resolved for harness {:?}", harness.name)));
        }
    }
    if !diags.is_empty() {
        return Err(diags);
    }

    // Stable topological sort: parents before children, otherwise declaration order.
    let mut remaining: Vec<&crate::spec::Harness> = nodes.clone();
    let mut emitted: HashSet<&str> = HashSet::new();
    let mut ordered: Vec<&crate::spec::Harness> = Vec::new();
    while !remaining.is_empty() {
        let ready = remaining.iter().position(|h| match &h.parent {
            None => true,
            Some(parent) => !in_team(parent) || emitted.contains(parent.as_str()),
        });
        let index = ready.unwrap_or(0);
        let harness = remaining.remove(index);
        emitted.insert(harness.name.as_str());
        ordered.push(harness);
    }

    let mut steps = Vec::new();
    for harness in &ordered {
        let found = resolved.iter().find(|r| r.harness == harness.name).expect("resolved checked above");
        let name = session_name(&harness.name, prefix);
        let parent = harness.parent.as_ref().filter(|p| in_team(p)).map(|p| session_name(p, prefix));
        let model = found.display_model();
        let sub = |templ: &Templ| substitute(templ, resolved, spec, harness.line, &harness.name);
        let mut argv: Vec<Templ> = vec![
            Templ::lit("open"),
            Templ::lit("-n"),
            Templ::lit(&name),
            Templ::lit("--role"),
            Templ::lit(&harness.role),
        ];
        if let Some(parent_name) = &parent {
            argv.push(Templ::lit("--parent"));
            argv.push(Templ::lit(parent_name));
        }
        argv.push(Templ::lit("--model"));
        argv.push(Templ::lit(&model));
        if let Some(title) = &harness.open.title {
            argv.push(Templ::lit("--title"));
            argv.push(sub(title)?);
        }
        if let Some(cols) = harness.open.cols {
            argv.push(Templ::lit("-C"));
            argv.push(Templ::lit(&cols.to_string()));
        }
        if let Some(rows) = harness.open.rows {
            argv.push(Templ::lit("-R"));
            argv.push(Templ::lit(&rows.to_string()));
        }
        if let Some(cwd) = &harness.open.cwd {
            argv.push(Templ::lit("--cwd"));
            argv.push(sub(cwd)?);
        }
        for (key, value) in &harness.open.env {
            argv.push(Templ::lit("--env"));
            let value = sub(value)?;
            let mut merged = vec![Part::Lit(format!("{key}="))];
            for part in value.0 {
                match part {
                    Part::Lit(text) => push_lit(&mut merged, text),
                    other => merged.push(other),
                }
            }
            argv.push(Templ(merged));
        }
        if let Some(trace_dir) = &opts.trace_dir {
            argv.push(Templ::lit("--record"));
            argv.push(Templ::lit(&trace_dir.join(format!("{name}.jsonl")).display().to_string()));
        }
        if opts.detached || harness.open.detached {
            argv.push(Templ::lit("--detached"));
        }
        argv.push(Templ::lit("--"));
        for command in &harness.open.command {
            argv.push(sub(command)?);
        }
        steps.push(OpenStep { harness: harness.name.clone(), name, role: harness.role.clone(), parent, model, argv });
    }

    Ok(Plan { team: team.to_owned(), root: session_name(&team_block.root, prefix), steps, edges: edges(spec, team_block, prefix) })
}

/// Manifest for a plan (what `graphloop up` writes). `source` is the absolute path of the .yah.
pub fn manifest(spec: &Spec, plan: &Plan, resolved: &[Resolved], source: &str, opts: &PlanOpts) -> Manifest {
    let created_ms = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
    let nodes = plan
        .steps
        .iter()
        .map(|step| {
            let tools = spec.harness(&step.harness).map(|h| h.tools.clone()).unwrap_or_default();
            let (requested_model, model, model_label, pick) = match resolved.iter().find(|r| r.harness == step.harness) {
                Some(found) => (
                    found.requested.clone(),
                    found.display_model(),
                    found.label.clone(),
                    PickInfo { via: found.via.as_str().to_owned(), rule: found.rule.clone(), reason: found.reason.clone(), degraded_level: found.degraded_level },
                ),
                None => (step.model.clone(), step.model.clone(), String::new(), PickInfo { via: String::new(), rule: None, reason: String::new(), degraded_level: 0 }),
            };
            Node { name: step.name.clone(), harness: step.harness.clone(), role: step.role.clone(), parent: step.parent.clone(), requested_model, model, model_label, pick, tools }
        })
        .collect();
    Manifest {
        version: crate::manifest::VERSION,
        run: opts.run.clone(),
        team: plan.team.clone(),
        source: source.to_owned(),
        root: plan.root.clone(),
        created_ms,
        trace_dir: opts.trace_dir.as_ref().map(|dir| dir.display().to_string()),
        nodes,
        edges: plan.edges.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pick::Via;
    use crate::spec::{Harness, ModelRef, Open};

    fn harness(name: &str, role: &str, parent: Option<&str>, line: u32) -> Harness {
        Harness {
            name: name.to_owned(),
            kind: "h1".to_owned(),
            role: role.to_owned(),
            parent: parent.map(str::to_owned),
            model: ModelRef::SystemOne,
            tools: vec!["fs".to_owned()],
            complexity: None,
            open: Open { command: vec![Templ::lit("pi")], cols: None, rows: None, cwd: None, env: Vec::new(), title: None, detached: false },
            line,
        }
    }

    fn team(root: &str, members: &[&str]) -> Team {
        Team { name: "default".to_owned(), root: root.to_owned(), members: members.iter().map(|m| m.to_string()).collect(), graph: true, line: 50 }
    }

    fn spec(harnesses: Vec<Harness>, team: Team) -> Spec {
        Spec {
            version: 1,
            file: "team.yah".to_owned(),
            variables: Vec::new(),
            defaults: Default::default(),
            providers: Vec::new(),
            models: Vec::new(),
            system_one: None,
            image: None,
            apis: Vec::new(),
            harnesses,
            teams: vec![team],
            workflows: Vec::new(),
            vaults: Vec::new(),
            outputs: Vec::new(),
        }
    }

    fn res(name: &str, provider_type: &str, id: &str) -> Resolved {
        Resolved {
            harness: name.to_owned(),
            requested: "system-one".to_owned(),
            label: "sonnet".to_owned(),
            id: id.to_owned(),
            provider_type: provider_type.to_owned(),
            via: Via::SystemOne,
            rule: Some("R3".to_owned()),
            reason: "strict constraints".to_owned(),
            degraded_level: 0,
        }
    }

    fn resolved(names: &[&str]) -> Vec<Resolved> {
        names.iter().map(|n| res(n, "anthropic", "claude-sonnet-5-5")).collect()
    }

    fn opts() -> PlanOpts {
        PlanOpts { prefix: None, run: "run-1".to_owned(), trace_dir: None, detached: false }
    }

    fn basic() -> (Spec, Vec<Resolved>) {
        let s = spec(vec![harness("commander", "commander", None, 10), harness("builder", "worker", Some("commander"), 20)], team("commander", &["builder"]));
        (s, resolved(&["commander", "builder"]))
    }

    fn displays(step: &OpenStep) -> Vec<String> {
        step.argv.iter().map(|t| t.display()).collect()
    }

    fn strings(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    fn err_text(result: Result<Plan, Diagnostics>) -> String {
        result.unwrap_err().0.iter().map(|d| format!("{} {}", d.summary, d.detail)).collect::<Vec<_>>().join("\n")
    }

    #[test]
    fn commander_builder_exact_argv() {
        let (s, r) = basic();
        let plan = build(&s, "default", &r, &opts()).unwrap();
        assert_eq!(plan.team, "default");
        assert_eq!(plan.root, "commander");
        assert_eq!(displays(&plan.steps[0]), strings(&["open", "-n", "commander", "--role", "commander", "--model", "anthropic/claude-sonnet-5-5", "--", "pi"]));
        assert_eq!(displays(&plan.steps[1]), strings(&["open", "-n", "builder", "--role", "worker", "--parent", "commander", "--model", "anthropic/claude-sonnet-5-5", "--", "pi"]));
        assert_eq!(plan.steps[1].parent.as_deref(), Some("commander"));
        assert_eq!(plan.steps[1].model, "anthropic/claude-sonnet-5-5");
    }

    #[test]
    fn prefix_applies_to_names_parent_and_root() {
        let (s, r) = basic();
        let o = PlanOpts { prefix: Some("gl".to_owned()), ..opts() };
        let plan = build(&s, "default", &r, &o).unwrap();
        assert_eq!(plan.root, "gl-commander");
        assert_eq!(plan.steps[1].name, "gl-builder");
        assert_eq!(plan.steps[1].parent.as_deref(), Some("gl-commander"));
        assert!(displays(&plan.steps[1]).contains(&"gl-builder".to_owned()));
    }

    #[test]
    fn edges_parent_first_then_member() {
        let s = spec(
            vec![harness("commander", "commander", None, 10), harness("builder", "worker", Some("commander"), 20), harness("scout", "worker", None, 30)],
            team("commander", &["builder", "scout"]),
        );
        let plan = build(&s, "default", &resolved(&["commander", "builder", "scout"]), &opts()).unwrap();
        assert_eq!(
            plan.edges,
            vec![
                Edge { from: "commander".to_owned(), to: "builder".to_owned(), kind: EdgeKind::Parent },
                Edge { from: "commander".to_owned(), to: "scout".to_owned(), kind: EdgeKind::Member },
            ]
        );
    }

    #[test]
    fn edges_use_session_names_with_prefix() {
        let (s, _) = basic();
        let t = s.team("default").unwrap().clone();
        let e = edges(&s, &t, Some("gl"));
        assert_eq!(e, vec![Edge { from: "gl-commander".to_owned(), to: "gl-builder".to_owned(), kind: EdgeKind::Parent }]);
    }

    #[test]
    fn detached_from_opts() {
        let (s, r) = basic();
        let o = PlanOpts { detached: true, ..opts() };
        let plan = build(&s, "default", &r, &o).unwrap();
        assert!(plan.steps.iter().all(|step| displays(step).contains(&"--detached".to_owned())));
    }

    #[test]
    fn detached_from_open_block() {
        let (mut s, r) = basic();
        s.harnesses[1].open.detached = true;
        let plan = build(&s, "default", &r, &opts()).unwrap();
        assert!(!displays(&plan.steps[0]).contains(&"--detached".to_owned()));
        assert!(displays(&plan.steps[1]).contains(&"--detached".to_owned()));
    }

    #[test]
    fn trace_dir_adds_record_path() {
        let (s, r) = basic();
        let o = PlanOpts { trace_dir: Some(PathBuf::from("/tmp/trace")), ..opts() };
        let plan = build(&s, "default", &r, &o).unwrap();
        let d = displays(&plan.steps[1]);
        let at = d.iter().position(|a| a == "--record").unwrap();
        assert_eq!(d[at + 1], "/tmp/trace/builder.jsonl");
    }

    #[test]
    fn title_cols_rows_cwd_in_order() {
        let (mut s, r) = basic();
        s.harnesses[1].open.title = Some(Templ::lit("Build it"));
        s.harnesses[1].open.cols = Some(120);
        s.harnesses[1].open.rows = Some(40);
        s.harnesses[1].open.cwd = Some(Templ::lit("/work"));
        let plan = build(&s, "default", &r, &opts()).unwrap();
        assert_eq!(
            displays(&plan.steps[1]),
            strings(&["open", "-n", "builder", "--role", "worker", "--parent", "commander", "--model", "anthropic/claude-sonnet-5-5", "--title", "Build it", "-C", "120", "-R", "40", "--cwd", "/work", "--", "pi"])
        );
    }

    #[test]
    fn env_values_are_prefixed_and_env_parts_stay_late_bound() {
        let (mut s, r) = basic();
        s.harnesses[1].open.env = vec![("MODE".to_owned(), Templ::lit("fast")), ("KEY".to_owned(), Templ(vec![Part::Env("SECRET".to_owned())]))];
        let plan = build(&s, "default", &r, &opts()).unwrap();
        let d = displays(&plan.steps[1]);
        assert!(d.contains(&"MODE=fast".to_owned()));
        assert!(d.contains(&"KEY=${env.SECRET}".to_owned()));
        let at = d.iter().position(|a| a == "MODE=fast").unwrap();
        assert_eq!(plan.steps[1].argv[at], Templ::lit("MODE=fast"));
    }

    #[test]
    fn shell_plain_line() {
        let (s, r) = basic();
        let plan = build(&s, "default", &r, &opts()).unwrap();
        assert_eq!(plan.steps[1].shell(), "h1 open -n builder --role worker --parent commander --model anthropic/claude-sonnet-5-5 -- pi");
    }

    fn manual_step(argv: Vec<Templ>) -> OpenStep {
        OpenStep { harness: "h".to_owned(), name: "h".to_owned(), role: "worker".to_owned(), parent: None, model: "p/m".to_owned(), argv }
    }

    #[test]
    fn shell_quotes_spaces() {
        assert_eq!(manual_step(vec![Templ::lit("open"), Templ::lit("a b")]).shell(), "h1 open 'a b'");
    }

    #[test]
    fn shell_quotes_single_quote() {
        assert_eq!(manual_step(vec![Templ::lit("it's")]).shell(), "h1 'it'\\''s'");
    }

    #[test]
    fn shell_quotes_dollar() {
        assert_eq!(manual_step(vec![Templ::lit("$HOME")]).shell(), "h1 '$HOME'");
    }

    #[test]
    fn shell_quotes_empty_string() {
        assert_eq!(manual_step(vec![Templ::lit("")]).shell(), "h1 ''");
    }

    #[test]
    fn shell_shows_env_part_unexpanded() {
        let step = manual_step(vec![Templ(vec![Part::Env("SECRET".to_owned())])]);
        assert_eq!(step.shell(), "h1 '${env.SECRET}'");
    }

    #[test]
    fn render_expands_env() {
        let step = manual_step(vec![Templ(vec![Part::Lit("KEY=".to_owned()), Part::Env("SECRET".to_owned())])]);
        let ctx = RenderCtx { env: &|name| (name == "SECRET").then(|| "s3cr3t".to_owned()), model: &|_| None, vault: &|_, _| Err("no vault".to_owned()) };
        assert_eq!(step.render(&ctx).unwrap(), strings(&["KEY=s3cr3t"]));
    }

    #[test]
    fn render_missing_env_errors_and_names_it() {
        let step = manual_step(vec![Templ(vec![Part::Env("SECRET".to_owned())])]);
        let ctx = RenderCtx { env: &|_| None, model: &|_| None, vault: &|_, _| Err("no vault".to_owned()) };
        let err = step.render(&ctx).unwrap_err();
        assert!(err.contains("SECRET"), "{err}");
    }

    #[test]
    fn render_harness_model_part_uses_ctx() {
        let step = manual_step(vec![Templ(vec![Part::HarnessModel("builder".to_owned())])]);
        let ctx = RenderCtx { env: &|_| None, model: &|name| (name == "builder").then(|| "anthropic/x".to_owned()), vault: &|_, _| Err("no vault".to_owned()) };
        assert_eq!(step.render(&ctx).unwrap(), strings(&["anthropic/x"]));
        let ctx_none = RenderCtx { env: &|_| None, model: &|_| None, vault: &|_, _| Err("no vault".to_owned()) };
        assert!(step.render(&ctx_none).unwrap_err().contains("builder"));
    }

    #[test]
    fn render_harness_model_id_part_strips_provider() {
        let step = manual_step(vec![Templ(vec![Part::HarnessModelId("builder".to_owned())])]);
        assert_eq!(step.argv[0].display(), "${harnesses.builder.model_id}");
        let ctx = RenderCtx { env: &|_| None, model: &|name| (name == "builder").then(|| "anthropic/x".to_owned()), vault: &|_, _| Err("no vault".to_owned()) };
        assert_eq!(step.render(&ctx).unwrap(), strings(&["x"]));
        let ctx_none = RenderCtx { env: &|_| None, model: &|_| None, vault: &|_, _| Err("no vault".to_owned()) };
        assert!(step.render(&ctx_none).unwrap_err().contains("builder"));
    }

    #[test]
    fn topo_children_declared_before_parents() {
        let s = spec(vec![harness("builder", "worker", Some("commander"), 20), harness("commander", "commander", None, 10)], team("commander", &["builder"]));
        let plan = build(&s, "default", &resolved(&["commander", "builder"]), &opts()).unwrap();
        assert_eq!(plan.steps.iter().map(|s| s.harness.as_str()).collect::<Vec<_>>(), vec!["commander", "builder"]);
    }

    #[test]
    fn topo_stable_in_declaration_order() {
        let s = spec(
            vec![harness("commander", "commander", None, 10), harness("zeta", "worker", None, 20), harness("alpha", "worker", None, 30)],
            team("commander", &["alpha", "zeta"]),
        );
        let plan = build(&s, "default", &resolved(&["commander", "zeta", "alpha"]), &opts()).unwrap();
        assert_eq!(plan.steps.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(), vec!["commander", "zeta", "alpha"]);
    }

    #[test]
    fn three_level_chain_orders_and_edges() {
        let s = spec(
            vec![harness("worker", "worker", Some("mgr"), 30), harness("mgr", "manager", Some("commander"), 20), harness("commander", "commander", None, 10)],
            team("commander", &["mgr", "worker"]),
        );
        let plan = build(&s, "default", &resolved(&["commander", "mgr", "worker"]), &opts()).unwrap();
        assert_eq!(plan.steps.iter().map(|s| s.harness.as_str()).collect::<Vec<_>>(), vec!["commander", "mgr", "worker"]);
        assert_eq!(plan.steps[2].parent.as_deref(), Some("mgr"));
        assert_eq!(plan.edges.len(), 2);
        assert!(plan.edges.iter().all(|e| e.kind == EdgeKind::Parent));
    }

    #[test]
    fn parent_outside_team_is_an_error() {
        let s = spec(
            vec![harness("commander", "commander", None, 10), harness("builder", "worker", Some("outsider"), 20), harness("outsider", "worker", None, 30)],
            team("commander", &["builder"]),
        );
        let text = err_text(build(&s, "default", &resolved(&["commander", "builder", "outsider"]), &opts()));
        assert!(text.contains("builder") && text.contains("outsider"), "{text}");
    }

    #[test]
    fn ancestor_outside_team_is_an_error() {
        let s = spec(
            vec![harness("commander", "commander", None, 10), harness("mgr", "manager", Some("outsider"), 20), harness("worker", "worker", Some("mgr"), 30), harness("outsider", "worker", None, 40)],
            team("commander", &["mgr", "worker"]),
        );
        let text = err_text(build(&s, "default", &resolved(&["commander", "mgr", "worker", "outsider"]), &opts()));
        assert!(text.contains("outsider"), "{text}");
    }

    #[test]
    fn parent_cycle_is_an_error() {
        let s = spec(vec![harness("a", "commander", Some("b"), 10), harness("b", "worker", Some("a"), 20)], team("a", &["b"]));
        let text = err_text(build(&s, "default", &resolved(&["a", "b"]), &opts()));
        assert!(text.contains("cycle"), "{text}");
    }

    #[test]
    fn self_parent_is_a_cycle() {
        let s = spec(vec![harness("a", "commander", Some("a"), 10)], team("a", &[]));
        let text = err_text(build(&s, "default", &resolved(&["a"]), &opts()));
        assert!(text.contains("cycle"), "{text}");
    }

    #[test]
    fn wrong_kind_is_an_error() {
        let (mut s, r) = basic();
        s.harnesses[1].kind = "shell".to_owned();
        let text = err_text(build(&s, "default", &r, &opts()));
        assert!(text.contains("shell") && text.contains("builder"), "{text}");
    }

    #[test]
    fn name_too_long_is_an_error() {
        let long = "a".repeat(41);
        let s = spec(vec![harness(&long, "commander", None, 10)], team(&long, &[]));
        let text = err_text(build(&s, "default", &resolved(&[&long]), &opts()));
        assert!(text.contains("40"), "{text}");
    }

    #[test]
    fn prefix_can_push_a_name_over_the_limit() {
        let label = "a".repeat(38);
        let s = spec(vec![harness(&label, "commander", None, 10)], team(&label, &[]));
        let r = resolved(&[&label]);
        assert!(build(&s, "default", &r, &opts()).is_ok());
        let o = PlanOpts { prefix: Some("gl".to_owned()), ..opts() };
        assert!(build(&s, "default", &r, &o).is_err());
    }

    #[test]
    fn name_with_leading_dot_is_an_error() {
        let s = spec(vec![harness(".hidden", "commander", None, 10)], team(".hidden", &[]));
        let text = err_text(build(&s, "default", &resolved(&[".hidden"]), &opts()));
        assert!(text.contains("starts with '.'"), "{text}");
    }

    #[test]
    fn name_with_bad_characters_is_an_error() {
        let s = spec(vec![harness("bad name", "commander", None, 10)], team("bad name", &[]));
        let text = err_text(build(&s, "default", &resolved(&["bad name"]), &opts()));
        assert!(text.contains("invalid character"), "{text}");
    }

    #[test]
    fn unknown_team_lists_defined_teams() {
        let (s, r) = basic();
        let text = err_text(build(&s, "nope", &r, &opts()));
        assert!(text.contains("nope") && text.contains("default"), "{text}");
    }

    #[test]
    fn unknown_member_is_an_error() {
        let s = spec(vec![harness("commander", "commander", None, 10)], team("commander", &["ghost"]));
        let text = err_text(build(&s, "default", &resolved(&["commander"]), &opts()));
        assert!(text.contains("ghost"), "{text}");
    }

    #[test]
    fn unknown_root_is_an_error() {
        let s = spec(vec![harness("commander", "commander", None, 10)], team("ghost", &["commander"]));
        let text = err_text(build(&s, "default", &resolved(&["commander"]), &opts()));
        assert!(text.contains("ghost"), "{text}");
    }

    #[test]
    fn missing_resolved_model_is_an_error() {
        let (s, _) = basic();
        let text = err_text(build(&s, "default", &resolved(&["commander"]), &opts()));
        assert!(text.contains("builder"), "{text}");
    }

    #[test]
    fn harness_model_reference_is_substituted_now() {
        let (mut s, _) = basic();
        s.harnesses[0].open.command = vec![Templ(vec![Part::Lit("run --model ".to_owned()), Part::HarnessModel("builder".to_owned())])];
        let r = vec![res("commander", "anthropic", "c-model"), res("builder", "prov", "b-model")];
        let plan = build(&s, "default", &r, &opts()).unwrap();
        let last = plan.steps[0].argv.last().unwrap();
        assert_eq!(last.display(), "run --model prov/b-model");
        assert!(last.is_static());
    }

    #[test]
    fn harness_model_id_reference_is_substituted_bare() {
        let (mut s, _) = basic();
        s.harnesses[0].open.command = vec![Templ(vec![Part::Lit("run --model ".to_owned()), Part::HarnessModelId("builder".to_owned())])];
        let r = vec![res("commander", "anthropic", "c-model"), res("builder", "prov", "b-model")];
        let plan = build(&s, "default", &r, &opts()).unwrap();
        let last = plan.steps[0].argv.last().unwrap();
        assert_eq!(last.display(), "run --model b-model");
        assert!(last.is_static());
    }

    #[test]
    fn harness_model_id_reference_without_resolved_is_an_error() {
        let (mut s, r) = basic();
        s.harnesses[0].open.command = vec![Templ(vec![Part::HarnessModelId("ghost".to_owned())])];
        let text = err_text(build(&s, "default", &r, &opts()));
        assert!(text.contains("ghost"), "{text}");
        assert!(text.contains("model_id"), "{text}");
    }

    #[test]
    fn harness_model_reference_without_resolved_is_an_error() {
        let (mut s, r) = basic();
        s.harnesses[0].open.command = vec![Templ(vec![Part::HarnessModel("ghost".to_owned())])];
        let text = err_text(build(&s, "default", &r, &opts()));
        assert!(text.contains("ghost"), "{text}");
    }

    #[test]
    fn manifest_contents() {
        let (s, r) = basic();
        let o = PlanOpts { trace_dir: Some(PathBuf::from("/tmp/trace")), ..opts() };
        let plan = build(&s, "default", &r, &o).unwrap();
        let m = manifest(&s, &plan, &r, "/abs/team.yah", &o);
        assert_eq!(m.version, 1);
        assert_eq!(m.run, "run-1");
        assert_eq!(m.team, "default");
        assert_eq!(m.source, "/abs/team.yah");
        assert_eq!(m.root, "commander");
        assert!(m.created_ms > 0);
        assert_eq!(m.trace_dir.as_deref(), Some("/tmp/trace"));
        assert_eq!(m.nodes.len(), 2);
        let node = &m.nodes[1];
        assert_eq!(node.name, "builder");
        assert_eq!(node.harness, "builder");
        assert_eq!(node.role, "worker");
        assert_eq!(node.parent.as_deref(), Some("commander"));
        assert_eq!(node.requested_model, "system-one");
        assert_eq!(node.model, "anthropic/claude-sonnet-5-5");
        assert_eq!(node.model_label, "sonnet");
        assert_eq!(node.pick.via, "system-one");
        assert_eq!(node.pick.rule.as_deref(), Some("R3"));
        assert_eq!(node.pick.reason, "strict constraints");
        assert_eq!(node.pick.degraded_level, 0);
        assert_eq!(node.tools, vec!["fs".to_owned()]);
        assert_eq!(m.edges, plan.edges);
    }

    #[test]
    fn manifest_json_round_trip() {
        let (s, r) = basic();
        let plan = build(&s, "default", &r, &opts()).unwrap();
        let m = manifest(&s, &plan, &r, "/abs/team.yah", &opts());
        let json = serde_json::to_string(&m).unwrap();
        let back: Manifest = serde_json::from_str(&json).unwrap();
        assert_eq!(back, m);
    }

    #[test]
    fn build_is_deterministic() {
        let (s, r) = basic();
        let a = build(&s, "default", &r, &opts()).unwrap();
        let b = build(&s, "default", &r, &opts()).unwrap();
        assert_eq!(a, b);
        let ma = manifest(&s, &a, &r, "/abs/team.yah", &opts());
        let mb = manifest(&s, &b, &r, "/abs/team.yah", &opts());
        assert_eq!(ma.nodes, mb.nodes);
        assert_eq!(ma.edges, mb.edges);
    }

    #[test]
    fn error_line_is_the_harness_line() {
        let (mut s, r) = basic();
        s.harnesses[1].kind = "shell".to_owned();
        let err = build(&s, "default", &r, &opts()).unwrap_err();
        assert_eq!(err.0[0].line, 20);
        assert_eq!(err.0[0].file, "team.yah");
    }
}

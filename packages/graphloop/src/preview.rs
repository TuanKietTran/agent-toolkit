//! The preview document: the contract between `graphloop preview` (writer) and `h1 console
//! --preview` (reader, which keeps its own tolerant copy of these types). SHARED CONTRACT, JSON,
//! version 1.
//!
//! A preview is a dry run of a team: variables resolved, spec validated, plan built, but
//! nothing launched. Producing one NEVER spawns a process (system-one included), never writes a
//! run manifest, never touches `~/.h1` or the session dir, never fetches a vault secret and
//! never expands `${env.*}`. It reads the .yah file (and, for the `missing_cwd` check, stats
//! literal cwd paths). It is deterministic: same file, same flags, same output.
//!
//! ```json
//! { "version": 1, "team": "default", "source": "examples/team.yah", "root": "commander",
//!   "prefix": null,
//!   "nodes": [ { "name": "commander", "harness": "commander", "role": "commander", "parent": null,
//!                "requested_model": "sonnet", "model": "anthropic/claude-sonnet-5-5",
//!                "model_label": "sonnet", "model_status": "pinned", "tools": ["fs"],
//!                "cwd": "/work", "env": [ { "key": "API_KEY", "value": "***", "source": "env", "masked": true } ],
//!                "open_command": "h1 open -n commander --role commander --model anthropic/claude-sonnet-5-5 -- pi" } ],
//!   "edges": [ { "from": "commander", "to": "builder", "kind": "parent" } ],
//!   "warnings": [ { "severity": "warn", "code": "empty_variable", "node": null, "message": "variable \"x\" is empty" } ] }
//! ```
//!
//! Rules (all decided here, builders and readers follow them):
//! - `nodes` are in plan order (parents before children); `edges` as `plan::edges`.
//!   `name` is the session name (prefix included); `harness` is the Graphspec label.
//! - `model_status`: `pinned` (catalog label resolved, `model` = `provider/id`), `pending`
//!   (`model = "system-one"`: decided only at `up`, `model` is null, `model_label` null),
//!   `unknown` (label not in the catalog, `model` null; also emits an `unknown_model` warning).
//! - `env[].value` is the template as written: literals shown, `${env.X}` / `${vault.v.k}`
//!   shown as references (never resolved). A literal whose key looks secret (contains KEY,
//!   TOKEN, SECRET, PASSWORD or PASSWD, case-insensitive) is `"***"` with `masked: true`.
//!   `source` is `literal` | `env` | `vault` | `mixed`.
//! - `open_command` is `OpenStep::shell()`: secret-free by construction.
//! - `cwd` is the rendered cwd when it is fully literal, else the template text, else null.
//! - Problems never abort the preview: a spec that parses and loads always yields a document,
//!   with problems in `warnings`. A file that does not load (syntax or schema error) yields no
//!   document: the command prints the usual diagnostics and exits 1.
//! - `warnings` are sorted by (node, code) for stable output. Codes: `empty_variable`,
//!   `unknown_model`, `duplicate_session`, `cycle`, `missing_cwd`, `invalid` (any other
//!   plan-build diagnostic, severity `error`). `cycle`, `duplicate_session` and `invalid` are
//!   errors; the rest are `warn`.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::manifest::EdgeKind;
use crate::pick::{Resolved, Via};
use crate::plan::{self, PlanOpts};
use crate::spec::{ModelRef, Part, Spec, Templ};

pub const PREVIEW_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Preview {
    pub version: u32,
    pub team: String,
    /// The path as given on the command line.
    pub source: String,
    /// Session name of the root.
    pub root: String,
    pub prefix: Option<String>,
    pub nodes: Vec<PreviewNode>,
    pub edges: Vec<PreviewEdge>,
    pub warnings: Vec<Warning>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PreviewNode {
    pub name: String,
    pub harness: String,
    pub role: String,
    pub parent: Option<String>,
    /// `system-one` or the pinned catalog label, as written.
    pub requested_model: String,
    /// `provider/id`; null unless `model_status == pinned`.
    pub model: Option<String>,
    pub model_label: Option<String>,
    pub model_status: ModelStatus,
    pub tools: Vec<String>,
    pub cwd: Option<String>,
    /// Declaration order, secrets masked.
    pub env: Vec<EnvEntry>,
    /// Printable `h1 open ...` line, no secret values.
    pub open_command: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ModelStatus {
    Pinned,
    Pending,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EnvEntry {
    pub key: String,
    pub value: String,
    pub source: EnvSource,
    pub masked: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EnvSource {
    Literal,
    Env,
    Vault,
    Mixed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PreviewEdge {
    pub from: String,
    pub to: String,
    /// `parent` | `member`
    pub kind: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Warning {
    pub severity: Severity,
    pub code: WarningCode,
    /// Session name the warning is about, null for file-level warnings.
    pub node: Option<String>,
    pub message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Severity {
    Warn,
    Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WarningCode {
    EmptyVariable,
    UnknownModel,
    DuplicateSession,
    Cycle,
    MissingCwd,
    Invalid,
}

#[derive(Debug, Clone, Default)]
pub struct PreviewOpts {
    /// Prepended as `PREFIX-` to every session name.
    pub prefix: Option<String>,
    /// Force `--detached` on every open.
    pub detached: bool,
    /// Stat fully-literal cwd paths and emit `missing_cwd` warnings.
    pub check_cwd: bool,
}

/// Per-harness model outcome: (status, model, model_label, requested_model,
/// `--model` argv patch for non-pinned nodes).
type ModelPreview = (
    ModelStatus,
    Option<String>,
    Option<String>,
    String,
    Option<String>,
);

fn session_name(label: &str, prefix: Option<&str>) -> String {
    match prefix {
        Some(prefix) => format!("{prefix}-{label}"),
        None => label.to_owned(),
    }
}

fn code_name(code: WarningCode) -> &'static str {
    match code {
        WarningCode::EmptyVariable => "empty_variable",
        WarningCode::UnknownModel => "unknown_model",
        WarningCode::DuplicateSession => "duplicate_session",
        WarningCode::Cycle => "cycle",
        WarningCode::MissingCwd => "missing_cwd",
        WarningCode::Invalid => "invalid",
    }
}

fn secret_key(key: &str) -> bool {
    let upper = key.to_ascii_uppercase();
    ["KEY", "TOKEN", "SECRET", "PASSWORD", "PASSWD"]
        .iter()
        .any(|w| upper.contains(w))
}

fn env_entry(key: &str, value: &Templ) -> EnvEntry {
    let (mut env, mut vault, mut other) = (false, false, false);
    for part in &value.0 {
        match part {
            Part::Lit(_) => {}
            Part::Env(_) => env = true,
            Part::Vault(..) => vault = true,
            Part::HarnessModel(_) | Part::HarnessModelId(_) => other = true,
        }
    }
    let source = match (env, vault, other) {
        (false, false, false) => EnvSource::Literal,
        (true, false, false) => EnvSource::Env,
        (false, true, false) => EnvSource::Vault,
        _ => EnvSource::Mixed,
    };
    if source == EnvSource::Literal && secret_key(key) {
        EnvEntry {
            key: key.to_owned(),
            value: "***".to_owned(),
            source,
            masked: true,
        }
    } else {
        EnvEntry {
            key: key.to_owned(),
            value: value.display(),
            source,
            masked: false,
        }
    }
}

/// Build a preview of `team` from an already-loaded `spec`. Never spawns a process,
/// never resolves a model through system-one, never fetches a vault secret and never
/// expands `${env.*}`. Plan problems become `warnings`; only a missing team yields
/// an empty document (plus an `invalid` warning).
pub fn build_preview(spec: &Spec, team: &str, opts: &PreviewOpts) -> Preview {
    let prefix = opts.prefix.as_deref();
    let mut warnings: Vec<Warning> = Vec::new();
    for var in &spec.variables {
        if var.value == serde_json::Value::String(String::new()) {
            warnings.push(Warning {
                severity: Severity::Warn,
                code: WarningCode::EmptyVariable,
                node: None,
                message: format!("variable {:?} is empty", var.name),
            });
        }
    }
    let finish = |nodes: Vec<PreviewNode>,
                  edges: Vec<PreviewEdge>,
                  root: String,
                  mut warnings: Vec<Warning>| {
        warnings.sort_by(|a, b| {
            (
                a.node.clone().unwrap_or_default(),
                code_name(a.code),
                a.message.clone(),
            )
                .cmp(&(
                    b.node.clone().unwrap_or_default(),
                    code_name(b.code),
                    b.message.clone(),
                ))
        });
        Preview {
            version: PREVIEW_VERSION,
            team: team.to_owned(),
            source: spec.file.clone(),
            root,
            prefix: opts.prefix.clone(),
            nodes,
            edges,
            warnings,
        }
    };
    let Some(team_block) = spec.team(team) else {
        warnings.push(Warning {
            severity: Severity::Error,
            code: WarningCode::Invalid,
            node: None,
            message: format!("team {team:?} is not defined"),
        });
        return finish(Vec::new(), Vec::new(), String::new(), warnings);
    };
    let mut labels: Vec<&str> = vec![team_block.root.as_str()];
    for member in &team_block.members {
        if !labels.contains(&member.as_str()) {
            labels.push(member.as_str());
        }
    }
    let team_harnesses: Vec<_> = spec
        .harnesses
        .iter()
        .filter(|h| labels.contains(&h.name.as_str()))
        .collect();
    // Model resolution without a picker: pinned from the catalog, system-one stays
    // pending, an undeclared label is unknown. The last status element is the
    // `--model` argument the open command carries for non-pinned nodes.
    let mut resolved: Vec<Resolved> = Vec::new();
    let mut status: Vec<ModelPreview> = Vec::new();
    for harness in &team_harnesses {
        let name = session_name(&harness.name, prefix);
        match &harness.model {
            ModelRef::SystemOne => {
                resolved.push(Resolved {
                    harness: harness.name.clone(),
                    requested: "system-one".into(),
                    label: "system-one".into(),
                    id: "system-one".into(),
                    provider_type: String::new(),
                    via: Via::Pinned,
                    rule: None,
                    reason: "preview: decided at up".into(),
                    degraded_level: 0,
                });
                status.push((
                    ModelStatus::Pending,
                    None,
                    None,
                    "system-one".into(),
                    Some("system-one".into()),
                ));
            }
            ModelRef::Catalog(label) => match spec.model(label) {
                Some(model) => {
                    let provider_type = spec
                        .provider(&model.provider)
                        .map(|p| p.provider_type.clone())
                        .unwrap_or_else(|| model.provider.clone());
                    resolved.push(Resolved {
                        harness: harness.name.clone(),
                        requested: label.clone(),
                        label: label.clone(),
                        id: model.id.clone(),
                        provider_type: provider_type.clone(),
                        via: Via::Pinned,
                        rule: None,
                        reason: "preview: pinned".into(),
                        degraded_level: 0,
                    });
                    status.push((
                        ModelStatus::Pinned,
                        Some(format!("{provider_type}/{}", model.id)),
                        Some(label.clone()),
                        label.clone(),
                        None,
                    ));
                }
                None => {
                    warnings.push(Warning {
                        severity: Severity::Warn,
                        code: WarningCode::UnknownModel,
                        node: Some(name),
                        message: format!(
                            "harness {:?} refers to an unknown model {label:?}",
                            harness.name
                        ),
                    });
                    resolved.push(Resolved {
                        harness: harness.name.clone(),
                        requested: label.clone(),
                        label: label.clone(),
                        id: label.clone(),
                        provider_type: String::new(),
                        via: Via::Pinned,
                        rule: None,
                        reason: "preview: unknown model".into(),
                        degraded_level: 0,
                    });
                    status.push((
                        ModelStatus::Unknown,
                        None,
                        None,
                        label.clone(),
                        Some(label.clone()),
                    ));
                }
            },
        }
    }
    let mut seen: Vec<String> = Vec::new();
    for harness in &team_harnesses {
        let name = session_name(&harness.name, prefix);
        if seen.contains(&name) {
            warnings.push(Warning {
                severity: Severity::Error,
                code: WarningCode::DuplicateSession,
                node: Some(name.clone()),
                message: format!("duplicate session name {name:?}"),
            });
        } else {
            seen.push(name);
        }
    }
    let node_for = |harness: &crate::spec::Harness,
                    name: String,
                    parent: Option<String>,
                    open_command: String,
                    warnings: &mut Vec<Warning>| {
        let idx = team_harnesses
            .iter()
            .position(|h| h.name == harness.name)
            .unwrap_or(0);
        let (model_status, model, model_label, requested_model, _) = status[idx].clone();
        if opts.check_cwd
            && let Some(cwd) = &harness.open.cwd
            && cwd.is_static()
        {
            let text = cwd.display();
            if !Path::new(&text).exists() {
                warnings.push(Warning {
                    severity: Severity::Warn,
                    code: WarningCode::MissingCwd,
                    node: Some(name.clone()),
                    message: format!("cwd {text:?} does not exist"),
                });
            }
        }
        PreviewNode {
            name,
            harness: harness.name.clone(),
            role: harness.role.clone(),
            parent,
            requested_model,
            model,
            model_label,
            model_status,
            tools: harness.tools.clone(),
            cwd: harness.open.cwd.as_ref().map(|t| t.display()),
            env: harness
                .open
                .env
                .iter()
                .map(|(k, v)| env_entry(k, v))
                .collect(),
            open_command,
        }
    };
    let plan_opts = PlanOpts {
        prefix: opts.prefix.clone(),
        run: String::new(),
        trace_dir: None,
        detached: opts.detached,
    };
    match plan::build(spec, team, &resolved, &plan_opts) {
        Ok(plan) => {
            let mut nodes = Vec::new();
            for step in &plan.steps {
                let Some(harness) = spec.harness(&step.harness) else {
                    continue;
                };
                let idx = team_harnesses
                    .iter()
                    .position(|h| h.name == step.harness)
                    .unwrap_or(0);
                let mut step = step.clone();
                if let Some(patch) = &status[idx].4
                    && let Some(pos) = step.argv.iter().position(|a| a.display() == "--model")
                    && pos + 1 < step.argv.len()
                {
                    step.argv[pos + 1] = Templ::lit(patch);
                    step.model = patch.clone();
                }
                let open_command = step.shell();
                nodes.push(node_for(
                    harness,
                    step.name.clone(),
                    step.parent.clone(),
                    open_command,
                    &mut warnings,
                ));
            }
            let edges = plan
                .edges
                .iter()
                .map(|e| PreviewEdge {
                    from: e.from.clone(),
                    to: e.to.clone(),
                    kind: match e.kind {
                        EdgeKind::Parent => "parent".into(),
                        EdgeKind::Member => "member".into(),
                    },
                })
                .collect();
            finish(nodes, edges, plan.root.clone(), warnings)
        }
        Err(diags) => {
            for d in &diags.0 {
                let text = format!("{} {}", d.summary, d.detail).to_lowercase();
                let code = if text.contains("cycle") {
                    WarningCode::Cycle
                } else if text.contains("duplicate") {
                    WarningCode::DuplicateSession
                } else {
                    WarningCode::Invalid
                };
                warnings.push(Warning {
                    severity: Severity::Error,
                    code,
                    node: None,
                    message: d.detail.clone(),
                });
            }
            let mut nodes = Vec::new();
            for harness in &team_harnesses {
                let parent = harness
                    .parent
                    .as_ref()
                    .filter(|p| labels.contains(&p.as_str()))
                    .map(|p| session_name(p, prefix));
                nodes.push(node_for(
                    harness,
                    session_name(&harness.name, prefix),
                    parent,
                    String::new(),
                    &mut warnings,
                ));
            }
            let edges = plan::edges(spec, team_block, prefix)
                .iter()
                .map(|e| PreviewEdge {
                    from: e.from.clone(),
                    to: e.to.clone(),
                    kind: match e.kind {
                        EdgeKind::Parent => "parent".into(),
                        EdgeKind::Member => "member".into(),
                    },
                })
                .collect();
            finish(
                nodes,
                edges,
                session_name(&team_block.root, prefix),
                warnings,
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn contract_round_trips() {
        let p = Preview {
            version: PREVIEW_VERSION,
            team: "t".into(),
            source: "a.yah".into(),
            root: "r".into(),
            prefix: None,
            nodes: vec![PreviewNode {
                name: "r".into(),
                harness: "r".into(),
                role: "commander".into(),
                parent: None,
                requested_model: "system-one".into(),
                model: None,
                model_label: None,
                model_status: ModelStatus::Pending,
                tools: vec![],
                cwd: None,
                env: vec![EnvEntry {
                    key: "K".into(),
                    value: "***".into(),
                    source: EnvSource::Literal,
                    masked: true,
                }],
                open_command: "h1 open -n r".into(),
            }],
            edges: vec![],
            warnings: vec![Warning {
                severity: Severity::Warn,
                code: WarningCode::MissingCwd,
                node: Some("r".into()),
                message: "m".into(),
            }],
        };
        let text = serde_json::to_string(&p).unwrap();
        assert!(
            text.contains("\"model_status\":\"pending\"")
                && text.contains("\"code\":\"missing_cwd\"")
        );
        assert_eq!(serde_json::from_str::<Preview>(&text).unwrap(), p);
    }
}

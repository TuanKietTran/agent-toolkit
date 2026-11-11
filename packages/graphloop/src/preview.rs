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

use serde::{Deserialize, Serialize};

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

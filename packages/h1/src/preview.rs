//! Tolerant reader for Graphloop preview documents (`graphloop preview` JSON, version 1).
//!
//! The preview is the contract between `graphloop preview` (writer) and this console
//! (reader, `h1 console --preview`): a dry run of a team — nodes in plan order with
//! resolved/pinned/pending models, declaration-order env (values as written, secret-looking
//! literals already masked to `***` by the writer), the printable `h1 open ...` command per
//! node, edges, and warnings. Readers tolerate unknown fields and missing fields; a document
//! whose `version` is not understood is rejected, never half-shown. Nothing here writes,
//! spawns, or fetches anything: loading a preview is a pure file read.

use std::path::Path;

use serde::Deserialize;

/// The only preview version this reader understands.
pub const VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum ModelStatus {
    Pinned,
    Pending,
    #[default]
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum EnvSource {
    #[default]
    Literal,
    Env,
    Vault,
    Mixed,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Default)]
#[serde(default)]
pub struct EnvEntry {
    pub key: String,
    /// The template as written: literals shown, `${env.X}` / `${vault.v.k}` shown as
    /// references, secret-looking literals masked to `***` by the writer.
    pub value: String,
    pub source: EnvSource,
    pub masked: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Default)]
#[serde(default)]
pub struct Node {
    /// The h1 session name (prefix included).
    pub name: String,
    /// The Graphspec harness label.
    pub harness: String,
    pub role: String,
    pub parent: Option<String>,
    /// `system-one` or the pinned catalog label, as written.
    pub requested_model: String,
    /// Concrete `provider/id`; present only when `model_status == Pinned`.
    pub model: Option<String>,
    pub model_label: Option<String>,
    pub model_status: ModelStatus,
    pub tools: Vec<String>,
    pub cwd: Option<String>,
    /// Declaration order, secrets masked by the writer.
    pub env: Vec<EnvEntry>,
    /// Printable `h1 open ...` line, never contains secret values.
    pub open_command: String,
}

impl Node {
    /// The MODEL text for this node: the resolved `provider/id` when pinned, otherwise a
    /// short status word (`pending` for system-one, `unknown` for an uncatalogued label).
    pub fn model_text(&self) -> String {
        match self.model_status {
            ModelStatus::Pinned => self
                .model
                .clone()
                .unwrap_or_else(|| self.requested_model.clone()),
            ModelStatus::Pending => "pending".to_string(),
            ModelStatus::Unknown => "unknown".to_string(),
        }
    }
}

fn default_edge_kind() -> String {
    "parent".to_string()
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Default)]
#[serde(default)]
pub struct Edge {
    pub from: String,
    pub to: String,
    /// `parent` | `member`
    #[serde(default = "default_edge_kind")]
    pub kind: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum Severity {
    #[default]
    Warn,
    Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum WarningCode {
    EmptyVariable,
    UnknownModel,
    DuplicateSession,
    Cycle,
    MissingCwd,
    #[default]
    Invalid,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Default)]
#[serde(default)]
pub struct Warning {
    pub severity: Severity,
    pub code: WarningCode,
    /// Session name the warning is about, `None` for file-level warnings.
    pub node: Option<String>,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Default)]
#[serde(default)]
pub struct Preview {
    pub version: u32,
    pub team: String,
    /// The `.yah` path as given on the writer's command line.
    pub source: String,
    /// Session name of the root node.
    pub root: String,
    pub prefix: Option<String>,
    /// Plan order: parents before children.
    pub nodes: Vec<Node>,
    pub edges: Vec<Edge>,
    pub warnings: Vec<Warning>,
}

impl Preview {
    pub fn node(&self, name: &str) -> Option<&Node> {
        self.nodes.iter().find(|n| n.name == name)
    }

    pub fn warnings_for(&self, name: &str) -> impl Iterator<Item = &Warning> {
        self.warnings
            .iter()
            .filter(move |w| w.node.as_deref() == Some(name))
    }

    pub fn has_errors(&self) -> bool {
        self.warnings.iter().any(|w| w.severity == Severity::Error)
    }
}

/// Parse preview JSON text, rejecting a foreign `version`.
pub fn parse(text: &str) -> Result<Preview, String> {
    let preview: Preview =
        serde_json::from_str(text).map_err(|e| format!("invalid preview JSON: {e}"))?;
    if preview.version != VERSION {
        return Err(format!(
            "unsupported preview version {} (expected {VERSION})",
            preview.version
        ));
    }
    Ok(preview)
}

/// Load a preview document from `path`. Pure read: no writes, no spawns, no session dir.
pub fn load(path: &Path) -> Result<Preview, String> {
    let text = std::fs::read_to_string(path)
        .map_err(|e| format!("cannot read preview {}: {e}", path.display()))?;
    parse(&text)
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = r#"{
        "version": 1,
        "team": "default",
        "source": "examples/team.yah",
        "root": "commander",
        "prefix": null,
        "nodes": [
            { "name": "commander", "harness": "commander", "role": "commander", "parent": null,
              "requested_model": "sonnet", "model": "anthropic/claude-sonnet-5-5",
              "model_label": "sonnet", "model_status": "pinned", "tools": ["fs"],
              "cwd": "/work",
              "env": [ { "key": "API_KEY", "value": "***", "source": "literal", "masked": true },
                       { "key": "GREETING", "value": "${env.GREETING}", "source": "env", "masked": true } ],
              "open_command": "h1 open -n commander --role commander --model anthropic/claude-sonnet-5-5 -- pi" },
            { "name": "builder", "harness": "builder", "role": "worker", "parent": "commander",
              "requested_model": "system-one", "model": null, "model_label": null,
              "model_status": "pending", "tools": [], "cwd": null,
              "env": [ { "key": "TOKEN", "value": "${vault.local.TOKEN}", "source": "vault", "masked": true } ],
              "open_command": "h1 open -n builder --role worker --parent commander -- pi" }
        ],
        "edges": [ { "from": "commander", "to": "builder", "kind": "parent" },
                   { "from": "commander", "to": "builder", "kind": "member" } ],
        "warnings": [ { "severity": "warn", "code": "missing_cwd", "node": "builder", "message": "cwd ./work does not exist" },
                      { "severity": "error", "code": "unknown_model", "node": null, "message": "model \"nope\" is not in the catalog" } ],
        "unknown_top_level": 7
    }"#;

    #[test]
    fn parses_the_contract_and_ignores_unknown_fields() {
        let preview = parse(FIXTURE).expect("fixture parses");
        assert_eq!(preview.team, "default");
        assert_eq!(preview.root, "commander");
        assert_eq!(preview.nodes.len(), 2);
        let root = &preview.nodes[0];
        assert_eq!(root.model_status, ModelStatus::Pinned);
        assert_eq!(root.model_text(), "anthropic/claude-sonnet-5-5");
        assert_eq!(root.env[0].source, EnvSource::Literal);
        assert!(root.env[0].masked);
        assert_eq!(root.env[1].source, EnvSource::Env);
        let child = &preview.nodes[1];
        assert_eq!(child.model_status, ModelStatus::Pending);
        assert_eq!(child.model_text(), "pending");
        assert_eq!(child.env[0].source, EnvSource::Vault);
        assert_eq!(preview.edges[1].kind, "member");
        assert_eq!(preview.warnings[0].code, WarningCode::MissingCwd);
        assert_eq!(preview.warnings[0].severity, Severity::Warn);
        assert!(preview.has_errors());
        assert_eq!(preview.warnings_for("builder").count(), 1);
        assert_eq!(preview.node("builder").unwrap().harness, "builder");
    }

    #[test]
    fn missing_fields_default_at_the_serde_level() {
        let preview: Preview = serde_json::from_str("{}").expect("empty object parses");
        assert_eq!(preview.version, 0);
        assert!(preview.nodes.is_empty() && preview.edges.is_empty() && preview.warnings.is_empty());
        let node: Node = serde_json::from_str("{}").expect("empty node parses");
        assert_eq!(node.model_status, ModelStatus::Unknown);
        let edge: Edge = serde_json::from_str("{}").expect("empty edge parses");
        assert_eq!(edge.kind, "parent");
    }

    #[test]
    fn parse_rejects_foreign_version_and_malformed_json() {
        assert!(parse(r#"{"version": 2, "team": "x"}"#)
            .unwrap_err()
            .contains("unsupported preview version 2"));
        assert!(parse("{ not json").unwrap_err().contains("invalid preview JSON"));
    }

    #[test]
    fn load_reads_a_file_and_rejects_a_missing_one() {
        let dir = std::env::temp_dir().join(format!("preview-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("preview.json");
        std::fs::write(&path, FIXTURE).unwrap();
        assert_eq!(load(&path).unwrap().team, "default");
        assert!(load(&dir.join("nope.json")).unwrap_err().contains("cannot read preview"));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}

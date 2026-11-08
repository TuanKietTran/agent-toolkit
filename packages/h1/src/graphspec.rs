//! Tolerant reader for Graphspec run manifests (`<session_dir>/graphs/*.json`, version 1).
//!
//! The manifest is the contract between `graphloop` (writer) and this console (reader): a team
//! of labs declared in a `.yah` file, the concrete model system-one picked for each node, and
//! the edges between them. Readers tolerate unknown fields, missing fields and unreadable or
//! foreign-version files; a manifest is only shown while at least one of its nodes is a live
//! session, otherwise it is stale and ignored. Nothing here ever writes or deletes a manifest.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use serde::Deserialize;

use crate::session;

/// The only manifest version this reader understands.
pub const VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Default)]
#[serde(default)]
pub struct PickInfo {
    /// `system-one` | `fallback` | `pinned`.
    pub via: String,
    pub rule: Option<String>,
    pub reason: String,
    pub degraded_level: u32,
}

impl PickInfo {
    /// Short provenance tag shown next to a resolved model: `s1 R3`, `fallback`, `pinned`.
    pub fn tag(&self) -> String {
        if self.via == "system-one" {
            match &self.rule {
                Some(rule) if !rule.is_empty() => format!("s1 {rule}"),
                _ => "s1".to_string(),
            }
        } else {
            self.via.clone()
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum EdgeKind {
    #[default]
    Parent,
    Member,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Default)]
#[serde(default)]
pub struct Edge {
    pub from: String,
    pub to: String,
    pub kind: EdgeKind,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Default)]
#[serde(default)]
pub struct Node {
    /// The h1 session name (the `-n` value, prefix included).
    pub name: String,
    /// The Graphspec harness label.
    pub harness: String,
    pub role: String,
    pub parent: Option<String>,
    /// `system-one` or the pinned catalog label.
    pub requested_model: String,
    /// Concrete `provider/id` the lab was opened with.
    pub model: String,
    pub model_label: String,
    pub pick: PickInfo,
    pub tools: Vec<String>,
    /// Env NAMES whose values came from a vault for this node (names only, never values).
    pub vault_env: Vec<String>,
}

impl Node {
    /// Short provenance tag for this node's pick (`s1 R3`, `fallback`, `pinned`).
    pub fn pick_tag(&self) -> String {
        self.pick.tag()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Default)]
#[serde(default)]
pub struct Manifest {
    pub version: u32,
    pub run: String,
    pub team: String,
    pub source: String,
    pub root: String,
    pub created_ms: u64,
    pub trace_dir: Option<String>,
    pub nodes: Vec<Node>,
    pub edges: Vec<Edge>,
}

/// A manifest node joined with the manifest it came from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NodeInfo {
    pub team: String,
    pub run: String,
    pub source: String,
    pub trace_dir: Option<String>,
    pub node: Node,
}

/// The live view over every non-stale manifest.
#[derive(Debug, Clone, Default)]
pub struct Overlay {
    /// Session name -> manifest node, for live sessions only.
    pub by_name: HashMap<String, NodeInfo>,
    /// Declared nodes whose session is not up yet, newest manifest last.
    pub planned: Vec<NodeInfo>,
    /// Edges from every active manifest, de-duplicated.
    pub edges: Vec<Edge>,
    /// Manifests with at least one live node, in `load_all` order (newest last).
    pub active: Vec<Manifest>,
}

impl Overlay {
    pub fn get(&self, name: &str) -> Option<&NodeInfo> {
        self.by_name.get(name)
    }

    /// One-line header for the newest active manifest: `team NAME · run RUN · N/M up`.
    pub fn header(&self) -> Option<String> {
        let manifest = self.active.last()?;
        let up = manifest
            .nodes
            .iter()
            .filter(|node| self.by_name.get(&node.name).is_some_and(|info| info.run == manifest.run))
            .count();
        Some(format!("team {} · run {} · {}/{} up", manifest.team, manifest.run, up, manifest.nodes.len()))
    }
}

fn graphs_dir() -> PathBuf {
    session::session_dir().join("graphs")
}

/// Every readable version-1 manifest in `<session_dir>/graphs`, oldest first (newest last).
pub fn load_all() -> Vec<Manifest> {
    load_all_from(&graphs_dir())
}

/// `load_all` against an explicit directory (tests, alternate session dirs).
pub fn load_all_from(dir: &Path) -> Vec<Manifest> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut paths: Vec<PathBuf> = entries
        .filter_map(|entry| entry.ok().map(|entry| entry.path()))
        .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
        .collect();
    paths.sort();
    let mut manifests: Vec<Manifest> = paths
        .iter()
        .filter_map(|path| std::fs::read_to_string(path).ok())
        .filter_map(|text| serde_json::from_str::<Manifest>(&text).ok())
        .filter(|manifest| manifest.version == VERSION)
        .collect();
    manifests.sort_by(|a, b| a.created_ms.cmp(&b.created_ms).then_with(|| a.run.cmp(&b.run)));
    manifests
}

/// Maps live session names to their manifest nodes. A manifest contributes only while at
/// least one of its nodes is live; its other nodes become PLANNED and its edges are added.
pub fn overlay(labs_live: &[&str], manifests: &[Manifest]) -> Overlay {
    let live: HashSet<&str> = labs_live.iter().copied().collect();
    let mut out = Overlay::default();
    let mut planned_seen: HashSet<String> = HashSet::new();
    let mut edge_seen: HashSet<(String, String, EdgeKind)> = HashSet::new();
    for manifest in manifests {
        if manifest.version != VERSION || !manifest.nodes.iter().any(|node| live.contains(node.name.as_str())) {
            continue;
        }
        out.active.push(manifest.clone());
        for node in &manifest.nodes {
            let info = NodeInfo {
                team: manifest.team.clone(),
                run: manifest.run.clone(),
                source: manifest.source.clone(),
                trace_dir: manifest.trace_dir.clone(),
                node: node.clone(),
            };
            if live.contains(node.name.as_str()) {
                out.by_name.insert(node.name.clone(), info);
            } else if planned_seen.insert(node.name.clone()) {
                out.planned.push(info);
            }
        }
        for edge in &manifest.edges {
            if edge_seen.insert((edge.from.clone(), edge.to.clone(), edge.kind)) {
                out.edges.push(edge.clone());
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = r#"{
        "version": 1, "run": "run-1", "team": "alpha", "source": "/abs/team.yah",
        "root": "cmdr", "created_ms": 42, "trace_dir": "/trace/run-1",
        "nodes": [
            { "name": "cmdr", "harness": "commander", "role": "commander", "parent": null,
              "requested_model": "system-one", "model": "anthropic/claude-sonnet-5-5",
              "model_label": "sonnet",
              "pick": { "via": "system-one", "rule": "R3", "reason": "strict constraints", "degraded_level": 0 },
              "tools": ["fs"], "future_field": true },
            { "name": "builder", "harness": "worker", "role": "worker", "parent": "cmdr",
              "requested_model": "system-one", "model": "openai/gpt-6-luna", "model_label": "luna",
              "pick": { "via": "fallback", "rule": null, "reason": "no strict match", "degraded_level": 1 } }
        ],
        "edges": [ { "from": "cmdr", "to": "builder", "kind": "parent" } ],
        "unknown_top_level": 7
    }"#;

    fn fixture() -> Manifest {
        serde_json::from_str(FIXTURE).expect("fixture parses")
    }

    #[test]
    fn parses_the_contract_and_ignores_unknown_fields() {
        let manifest = fixture();
        assert_eq!(manifest.team, "alpha");
        assert_eq!(manifest.nodes.len(), 2);
        assert_eq!(manifest.nodes[0].model, "anthropic/claude-sonnet-5-5");
        assert_eq!(manifest.nodes[0].pick_tag(), "s1 R3");
        assert_eq!(manifest.nodes[1].pick_tag(), "fallback");
        assert_eq!(manifest.edges[0].kind, EdgeKind::Parent);
    }

    #[test]
    fn overlay_maps_live_plans_rest_and_drops_stale() {
        let manifest = fixture();
        let over = overlay(&["cmdr"], std::slice::from_ref(&manifest));
        assert_eq!(over.get("cmdr").unwrap().node.model, "anthropic/claude-sonnet-5-5");
        assert_eq!(over.planned.len(), 1);
        assert_eq!(over.planned[0].node.name, "builder");
        assert_eq!(over.header().as_deref(), Some("team alpha · run run-1 · 1/2 up"));
        let stale = overlay(&["someone-else"], &[manifest]);
        assert!(stale.by_name.is_empty() && stale.planned.is_empty() && stale.active.is_empty());
    }

    #[test]
    fn load_all_from_skips_malformed_and_foreign_versions() {
        let dir = std::env::temp_dir().join(format!("graphspec-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("good.json"), FIXTURE).unwrap();
        std::fs::write(dir.join("bad.json"), "{ not json").unwrap();
        std::fs::write(dir.join("v2.json"), r#"{"version": 2, "run": "x"}"#).unwrap();
        let loaded = load_all_from(&dir);
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].run, "run-1");
        let _ = std::fs::remove_dir_all(&dir);
    }
}

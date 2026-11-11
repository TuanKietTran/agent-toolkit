//! The run manifest: the contract between `graphloop` (writer) and the readers
//! (`h1 console`, `lab-gui`). SHARED CONTRACT, JSON, version 1.
//!
//! Location: `<session dir>/graphs/<run>.json`, where `<session dir>` is exactly what
//! `h1` uses for its sockets and registry (`$H1_DIR`, else Windows
//! `%LOCALAPPDATA%\h1\sessions`, else `$XDG_RUNTIME_DIR` / `$TMPDIR` / system temp +
//! `h1`). Readers must tolerate unknown fields and a missing file; writers write
//! atomically (temp file + rename). The manifest never contains secrets or expanded `${env.*}`.
//!
//! ```json
//! { "version": 1, "run": "default-1762500000-ab12", "team": "default",
//!   "source": "/abs/team.yah", "root": "commander", "created_ms": 1762500000000,
//!   "trace_dir": "/home/u/.h1/runs/default-1762500000-ab12/trace",
//!   "nodes": [ { "name": "commander", "harness": "commander", "role": "commander", "parent": null,
//!                "requested_model": "system-one", "model": "anthropic/claude-sonnet-5-5",
//!                "model_label": "sonnet",
//!                "pick": { "via": "system-one", "rule": "R3", "reason": "strict constraints", "degraded_level": 0 },
//!                "tools": ["fs"] } ],
//!   "edges": [ { "from": "commander", "to": "builder", "kind": "parent" } ] }
//! ```
//! `name` is the h1 session name (the `-n` value, prefix included); `harness` is the
//! Graphspec label. `edges[].from/to` are session names. `via` is `system-one` | `fallback` | `pinned`.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

pub const VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Manifest {
    pub version: u32,
    pub run: String,
    pub team: String,
    pub source: String,
    pub root: String,
    pub created_ms: u64,
    #[serde(default)]
    pub trace_dir: Option<String>,
    pub nodes: Vec<Node>,
    pub edges: Vec<Edge>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Node {
    pub name: String,
    pub harness: String,
    pub role: String,
    pub parent: Option<String>,
    /// `system-one` or the pinned catalog label.
    pub requested_model: String,
    /// Concrete `provider/id` the lab was opened with.
    pub model: String,
    pub model_label: String,
    pub pick: PickInfo,
    #[serde(default)]
    pub tools: Vec<String>,
    /// Env NAMES whose values came from a vault for this node (names only, never values).
    #[serde(default)]
    pub vault_env: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PickInfo {
    pub via: String,
    #[serde(default)]
    pub rule: Option<String>,
    pub reason: String,
    #[serde(default)]
    pub degraded_level: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EdgeKind {
    Parent,
    Member,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Edge {
    pub from: String,
    pub to: String,
    pub kind: EdgeKind,
}

/// Same rule as h1's `session_dir`, plus `/graphs`.
pub fn dir() -> PathBuf {
    use std::env;
    let non_empty = |name: &str| env::var_os(name).filter(|v| !v.is_empty());
    let base = if let Some(p) = non_empty("H1_DIR") {
        PathBuf::from(p)
    } else if cfg!(windows) && non_empty("LOCALAPPDATA").is_some() {
        PathBuf::from(non_empty("LOCALAPPDATA").unwrap())
            .join("h1")
            .join("sessions")
    } else {
        non_empty("XDG_RUNTIME_DIR")
            .or_else(|| non_empty("TMPDIR"))
            .map(PathBuf::from)
            .unwrap_or_else(env::temp_dir)
            .join("h1")
    };
    base.join("graphs")
}

pub fn path_for(run: &str) -> PathBuf {
    dir().join(format!("{run}.json"))
}

impl Manifest {
    /// Atomic write (temp file in the same directory, then rename). Creates the directory.
    pub fn write(&self) -> Result<PathBuf> {
        let path = path_for(&self.run);
        let parent = path.parent().context("manifest path has no parent")?;
        std::fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
        let tmp = parent.join(format!(".{}.tmp", self.run));
        std::fs::write(&tmp, serde_json::to_vec_pretty(self)?)
            .with_context(|| format!("write {}", tmp.display()))?;
        std::fs::rename(&tmp, &path).with_context(|| format!("rename to {}", path.display()))?;
        Ok(path)
    }

    pub fn read(path: &Path) -> Result<Manifest> {
        let bytes = std::fs::read(path).with_context(|| format!("read {}", path.display()))?;
        serde_json::from_slice(&bytes).with_context(|| format!("parse {}", path.display()))
    }

    /// Every readable manifest in [`dir`], oldest first. Unreadable files are skipped.
    pub fn list() -> Vec<Manifest> {
        let mut found: Vec<Manifest> = std::fs::read_dir(dir())
            .into_iter()
            .flatten()
            .flatten()
            .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
            .filter_map(|e| Manifest::read(&e.path()).ok())
            .collect();
        found.sort_by_key(|m| m.created_ms);
        found
    }

    pub fn remove(run: &str) -> Result<()> {
        let path = path_for(run);
        match std::fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e).with_context(|| format!("remove {}", path.display())),
        }
    }
}

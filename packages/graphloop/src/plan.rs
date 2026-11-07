//! Team -> `agent-cli-lab open` commands and graph edges. OWNER: gl-plan.
//!
//! Orchestration rules 1 and 3 (docs/graphspec.md): every harness with `kind = "agent-cli-lab"` is
//! started by `agent-cli-lab open -n NAME --role ROLE [--parent PARENT] --model <resolved> ...`;
//! the team block is the graph (nodes = harnesses; edges = parent relations plus `root -> member`
//! for a member that has no parent).

use std::path::PathBuf;

use crate::diag::Diagnostics;
use crate::manifest::{Edge, Manifest};
use crate::pick::Resolved;
use crate::spec::{RenderCtx, Spec, Team, Templ};

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

/// One `agent-cli-lab open` call.
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
        todo!("gl-plan: shell rendering with quoting")
    }
    /// Fully expanded argv (without the program name) for launching.
    pub fn render(&self, _ctx: &RenderCtx) -> Result<Vec<String>, String> {
        todo!("gl-plan: render argv")
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

/// Parent edges first, then member edges (`root -> member` for parentless non-root members).
pub fn edges(_spec: &Spec, _team: &Team, _prefix: Option<&str>) -> Vec<Edge> {
    todo!("gl-plan: edges")
}

/// Validate the team (root and members exist, every ancestor is in the team, no parent cycle,
/// `kind == "agent-cli-lab"`, session names valid: `[A-Za-z0-9._-]`, at most 40 chars, not starting
/// with `.`) and build the plan. Errors are `Diagnostics` with `file:line` of the harness or team.
pub fn build(
    _spec: &Spec,
    _team: &str,
    _resolved: &[Resolved],
    _opts: &PlanOpts,
) -> Result<Plan, Diagnostics> {
    todo!("gl-plan: build plan")
}

/// Manifest for a plan (what `graphloop up` writes). `source` is the absolute path of the .yah.
pub fn manifest(
    _spec: &Spec,
    _plan: &Plan,
    _resolved: &[Resolved],
    _source: &str,
    _opts: &PlanOpts,
) -> Manifest {
    todo!("gl-plan: manifest")
}

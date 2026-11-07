//! Model resolution: system-one decides `model = "system-one"`. OWNER: gl-s1.
//!
//! The data types and the `Picker` trait are SHARED CONTRACT (plan.rs and the manifest consume
//! `Resolved`). Rules:
//!   * a harness pinned to a catalog label is `Via::Pinned`; system-one is not asked.
//!   * `model = "system-one"` asks the picker with the catalog as `available` (ids). The answer must be
//!     the id of a catalog model; anything else (error, timeout, python missing, unknown id) uses
//!     `system_one.fallback` (`Via::Fallback`, with the reason). No `system_one` block / no fallback:
//!     that is an error naming the harness and its line. system-one only ever decides `model_pick`;
//!     never route anything else through it.

use std::path::PathBuf;

use crate::diag::Diagnostics;
use crate::spec::{Complexity, Spec};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CatalogEntry {
    pub label: String,
    pub id: String,
    pub provider_type: String,
    pub capabilities: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PickRequest {
    pub harness: String,
    pub role: String,
    pub complexity: Complexity,
    pub available: Vec<CatalogEntry>,
    pub needs_images: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PickDecision {
    pub model_id: String,
    pub rule: String,
    pub reason: String,
    pub degraded_level: u32,
}

pub trait Picker {
    fn pick(&self, request: &PickRequest) -> anyhow::Result<PickDecision>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Via {
    SystemOne,
    Fallback,
    Pinned,
}

impl Via {
    pub fn as_str(self) -> &'static str {
        match self {
            Via::SystemOne => "system-one",
            Via::Fallback => "fallback",
            Via::Pinned => "pinned",
        }
    }
}

/// The concrete model for one harness.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Resolved {
    pub harness: String,
    /// `system-one` or the pinned label.
    pub requested: String,
    pub label: String,
    pub id: String,
    pub provider_type: String,
    pub via: Via,
    pub rule: Option<String>,
    pub reason: String,
    pub degraded_level: u32,
}

impl Resolved {
    /// `provider_type/id`, what `agent-cli-lab open --model` receives and what
    /// `${harnesses.NAME.model}` expands to.
    pub fn display_model(&self) -> String {
        format!("{}/{}", self.provider_type, self.id)
    }
}

/// Runs system-one's `model_pick` through `python -m system_one.pick` (see gl-s1's brief).
#[derive(Debug, Clone)]
pub struct SystemOnePicker {
    pub python: String,
    /// `packages/system-one` (its `src` is put on PYTHONPATH).
    pub system_one_dir: PathBuf,
    pub student: Option<PathBuf>,
    pub timeout_ms: u64,
}

impl Picker for SystemOnePicker {
    fn pick(&self, _request: &PickRequest) -> anyhow::Result<PickDecision> {
        todo!("gl-s1: call python -m system_one.pick")
    }
}

/// Find `packages/system-one`: `$GRAPHLOOP_SYSTEM_ONE_DIR`, then walking up from the executable and
/// the current directory looking for `packages/system-one/src/system_one`. OWNER: gl-s1.
pub fn locate_system_one() -> Option<PathBuf> {
    todo!("gl-s1: locate packages/system-one")
}

/// One `Resolved` per harness, in declaration order. OWNER: gl-s1.
pub fn resolve_all(_spec: &Spec, _picker: &dyn Picker) -> Result<Vec<Resolved>, Diagnostics> {
    todo!("gl-s1: pinned / system-one / fallback")
}

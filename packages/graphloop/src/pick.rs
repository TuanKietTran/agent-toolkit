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

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use anyhow::{Context, anyhow};

use crate::ast::Span;
use crate::diag::{Diagnostic, Diagnostics};
use crate::spec::{Complexity, Harness, ModelRef, Spec};

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
    /// `provider_type/id`, what `h1 open --model` receives and what
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
    fn pick(&self, request: &PickRequest) -> anyhow::Result<PickDecision> {
        let python = match std::env::var("GRAPHLOOP_PYTHON") {
            Ok(p) if !p.trim().is_empty() => p,
            _ if !self.python.trim().is_empty() => self.python.clone(),
            _ => "python3".to_string(),
        };
        let scenario = serde_json::json!({
            "kind": "model_pick",
            "situation": "new",
            "complexity_hint": request.complexity.as_str(),
            "available": request.available.iter().map(|e| e.id.clone()).collect::<Vec<_>>(),
            "needs_images": request.needs_images,
        });
        let input = serde_json::to_string(&scenario)?;
        let mut cmd = Command::new(&python);
        cmd.arg("-m")
            .arg("system_one.pick")
            .env("PYTHONPATH", self.system_one_dir.join("src"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(student) = &self.student
            && student.is_file()
        {
            cmd.env("SYSTEM_ONE_STUDENT", student);
        }
        let mut child = cmd
            .spawn()
            .with_context(|| format!("failed to start {python} for system-one pick"))?;
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| anyhow!("system-one child has no stdin"))?;
        let writer = std::thread::spawn(move || {
            let _ = stdin.write_all(input.as_bytes());
            let _ = stdin.flush();
        });
        let mut out_pipe = child
            .stdout
            .take()
            .ok_or_else(|| anyhow!("system-one child has no stdout"))?;
        let out_reader = std::thread::spawn(move || {
            let mut text = String::new();
            let _ = out_pipe.read_to_string(&mut text);
            text
        });
        let mut err_pipe = child
            .stderr
            .take()
            .ok_or_else(|| anyhow!("system-one child has no stderr"))?;
        let err_reader = std::thread::spawn(move || {
            let mut text = String::new();
            let _ = err_pipe.read_to_string(&mut text);
            text
        });
        let timeout_ms = if self.timeout_ms == 0 {
            30_000
        } else {
            self.timeout_ms
        };
        let deadline = Instant::now() + Duration::from_millis(timeout_ms);
        let status = loop {
            match child.try_wait()? {
                Some(status) => break status,
                None if Instant::now() >= deadline => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(anyhow!("system-one pick timed out after {timeout_ms} ms"));
                }
                None => std::thread::sleep(Duration::from_millis(10)),
            }
        };
        let _ = writer.join();
        let stdout = out_reader.join().unwrap_or_default();
        let stderr = err_reader.join().unwrap_or_default();
        if !status.success() {
            let detail = if stderr.trim().is_empty() {
                stdout.trim().to_string()
            } else {
                stderr.trim().to_string()
            };
            let code = status
                .code()
                .map(|c| c.to_string())
                .unwrap_or_else(|| "unknown".to_string());
            return Err(anyhow!(
                "system-one pick failed with exit code {code}: {detail}"
            ));
        }
        let value: serde_json::Value = serde_json::from_str(stdout.trim())
            .map_err(|e| anyhow!("system-one returned invalid JSON: {e}"))?;
        if let Some(error) = value.get("error").and_then(|v| v.as_str()) {
            return Err(anyhow!("system-one pick failed: {error}"));
        }
        if let Some(kind) = value.get("kind").and_then(|v| v.as_str())
            && kind != "model_pick"
        {
            return Err(anyhow!(
                "system-one returned unexpected decision kind {kind:?}"
            ));
        }
        let model_id = value
            .get("model")
            .and_then(|v| v.as_str())
            .ok_or_else(|| anyhow!("system-one answer has no model id"))?
            .to_string();
        Ok(PickDecision {
            model_id,
            rule: value
                .get("rule")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string(),
            reason: value
                .get("reason")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string(),
            degraded_level: value
                .get("degraded_level")
                .and_then(|v| v.as_u64())
                .unwrap_or(0) as u32,
        })
    }
}

/// Find `packages/system-one`: `$GRAPHLOOP_SYSTEM_ONE_DIR`, then walking up from the executable and
/// the current directory looking for `packages/system-one/src/system_one`. OWNER: gl-s1.
fn is_system_one_dir(path: &Path) -> bool {
    path.join("src").join("system_one").is_dir()
}

pub fn locate_system_one() -> Option<PathBuf> {
    if let Ok(dir) = std::env::var("GRAPHLOOP_SYSTEM_ONE_DIR") {
        let candidate = PathBuf::from(dir);
        if is_system_one_dir(&candidate) {
            return Some(candidate);
        }
    }
    let mut starts: Vec<PathBuf> = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        starts.push(exe);
    }
    if let Ok(cwd) = std::env::current_dir() {
        starts.push(cwd);
    }
    for start in &starts {
        for ancestor in start.ancestors() {
            if is_system_one_dir(ancestor) && ancestor.ends_with("system-one") {
                return Some(ancestor.to_path_buf());
            }
            let candidate = ancestor.join("packages").join("system-one");
            if is_system_one_dir(&candidate) {
                return Some(candidate);
            }
        }
    }
    None
}

fn complexity_for_role(role: &str) -> Complexity {
    match role {
        "researcher" | "explorer" => Complexity::Low,
        "planner" | "reviewer" | "advisor" => Complexity::High,
        _ => Complexity::Medium,
    }
}

fn catalog_of(spec: &Spec) -> Vec<CatalogEntry> {
    spec.models
        .iter()
        .map(|m| CatalogEntry {
            label: m.name.clone(),
            id: m.id.clone(),
            provider_type: spec
                .provider(&m.provider)
                .map(|p| p.provider_type.clone())
                .unwrap_or_else(|| m.provider.clone()),
            capabilities: m.capabilities.clone(),
        })
        .collect()
}

#[allow(clippy::result_large_err)]
fn fallback_resolved(
    spec: &Spec,
    catalog: &[CatalogEntry],
    harness: &Harness,
    reason: String,
    degraded_level: u32,
) -> Result<Resolved, Diagnostic> {
    let entry = spec
        .system_one
        .as_ref()
        .and_then(|s| catalog.iter().find(|e| e.label == s.fallback));
    match entry {
        Some(entry) => Ok(Resolved {
            harness: harness.name.clone(),
            requested: "system-one".to_string(),
            label: entry.label.clone(),
            id: entry.id.clone(),
            provider_type: entry.provider_type.clone(),
            via: Via::Fallback,
            rule: None,
            reason,
            degraded_level,
        }),
        None => Err(Diagnostic::error(
            &spec.file,
            Span {
                line: harness.line,
                col: 1,
            },
            format!("Could not resolve model for harness \"{}\"", harness.name),
            format!(
                "The model for harness \"{}\" could not be resolved ({reason}), and no usable system_one fallback is configured. Set system_one.fallback to a catalog model label.",
                harness.name
            ),
        )),
    }
}

/// One `Resolved` per harness, in declaration order. OWNER: gl-s1.
pub fn resolve_all(spec: &Spec, picker: &dyn Picker) -> Result<Vec<Resolved>, Diagnostics> {
    let catalog = catalog_of(spec);
    let mut resolved: Vec<Resolved> = Vec::new();
    let mut diagnostics = Diagnostics::default();
    let mut cache: Vec<((String, Complexity), Result<PickDecision, String>)> = Vec::new();
    for harness in &spec.harnesses {
        match &harness.model {
            ModelRef::Catalog(label) => match catalog.iter().find(|e| &e.label == label) {
                Some(entry) => resolved.push(Resolved {
                    harness: harness.name.clone(),
                    requested: label.clone(),
                    label: entry.label.clone(),
                    id: entry.id.clone(),
                    provider_type: entry.provider_type.clone(),
                    via: Via::Pinned,
                    rule: None,
                    reason: format!("pinned in {}:{}", spec.file, harness.line),
                    degraded_level: 0,
                }),
                None => diagnostics.push(Diagnostic::error(
                    &spec.file,
                    Span { line: harness.line, col: 1 },
                    format!("Unknown model for harness \"{}\"", harness.name),
                    format!("Harness \"{}\" is pinned to model label \"{label}\", which is not in the catalog.", harness.name),
                )),
            },
            ModelRef::SystemOne => {
                let complexity = harness.complexity.unwrap_or_else(|| complexity_for_role(&harness.role));
                let key = (harness.role.clone(), complexity);
                let outcome = match cache.iter().find(|(k, _)| *k == key) {
                    Some((_, cached)) => cached.clone(),
                    None => {
                        let request = PickRequest {
                            harness: harness.name.clone(),
                            role: harness.role.clone(),
                            complexity,
                            available: catalog.clone(),
                            needs_images: false,
                        };
                        let result = picker.pick(&request).map_err(|e| e.to_string());
                        cache.push((key, result.clone()));
                        result
                    }
                };
                match outcome {
                    Ok(decision) => match catalog.iter().find(|e| e.id == decision.model_id) {
                        Some(entry) => resolved.push(Resolved {
                            harness: harness.name.clone(),
                            requested: "system-one".to_string(),
                            label: entry.label.clone(),
                            id: entry.id.clone(),
                            provider_type: entry.provider_type.clone(),
                            via: Via::SystemOne,
                            rule: Some(decision.rule.clone()),
                            reason: decision.reason.clone(),
                            degraded_level: decision.degraded_level,
                        }),
                        None => {
                            let reason = format!("system-one chose unknown model {}", decision.model_id);
                            match fallback_resolved(spec, &catalog, harness, reason, decision.degraded_level) {
                                Ok(r) => resolved.push(r),
                                Err(d) => diagnostics.push(d),
                            }
                        }
                    },
                    Err(why) => {
                        let reason = format!("system-one unavailable: {why}");
                        match fallback_resolved(spec, &catalog, harness, reason, 0) {
                            Ok(r) => resolved.push(r),
                            Err(d) => diagnostics.push(d),
                        }
                    }
                }
            }
        }
    }
    diagnostics.into_result(resolved)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::spec::{Defaults, Model, Open, Provider, SystemOne as SystemOneSpec};
    use std::cell::{Cell, RefCell};

    fn decision(id: &str) -> PickDecision {
        PickDecision {
            model_id: id.to_string(),
            rule: "test-rule".to_string(),
            reason: "test reason".to_string(),
            degraded_level: 2,
        }
    }

    struct FixedPicker(PickDecision);
    impl Picker for FixedPicker {
        fn pick(&self, _request: &PickRequest) -> anyhow::Result<PickDecision> {
            Ok(self.0.clone())
        }
    }

    struct ErrPicker;
    impl Picker for ErrPicker {
        fn pick(&self, _request: &PickRequest) -> anyhow::Result<PickDecision> {
            Err(anyhow!("boom"))
        }
    }

    struct CountingPicker {
        calls: Cell<usize>,
        decision: PickDecision,
    }
    impl Picker for CountingPicker {
        fn pick(&self, _request: &PickRequest) -> anyhow::Result<PickDecision> {
            self.calls.set(self.calls.get() + 1);
            Ok(self.decision.clone())
        }
    }

    struct CountingErrPicker {
        calls: Cell<usize>,
    }
    impl Picker for CountingErrPicker {
        fn pick(&self, _request: &PickRequest) -> anyhow::Result<PickDecision> {
            self.calls.set(self.calls.get() + 1);
            Err(anyhow!("boom"))
        }
    }

    struct RecordingPicker {
        requests: RefCell<Vec<PickRequest>>,
        decision: PickDecision,
    }
    impl Picker for RecordingPicker {
        fn pick(&self, request: &PickRequest) -> anyhow::Result<PickDecision> {
            self.requests.borrow_mut().push(request.clone());
            Ok(self.decision.clone())
        }
    }

    fn harness(
        name: &str,
        role: &str,
        model: ModelRef,
        complexity: Option<Complexity>,
        line: u32,
    ) -> Harness {
        Harness {
            name: name.to_string(),
            kind: "h1".to_string(),
            role: role.to_string(),
            parent: None,
            model,
            tools: Vec::new(),
            complexity,
            open: Open::default(),
            line,
        }
    }

    fn spec_with(harnesses: Vec<Harness>, with_system_one: bool) -> Spec {
        Spec {
            version: 1,
            file: "team.yah".to_string(),
            variables: Vec::new(),
            defaults: Defaults::default(),
            providers: vec![
                Provider {
                    name: "anthropic".to_string(),
                    provider_type: "anthropic".to_string(),
                    api_key_env: None,
                    base_url: None,
                    line: 2,
                },
                Provider {
                    name: "openai".to_string(),
                    provider_type: "openai".to_string(),
                    api_key_env: None,
                    base_url: None,
                    line: 3,
                },
            ],
            models: vec![
                Model {
                    name: "sonnet".to_string(),
                    provider: "anthropic".to_string(),
                    id: "claude-sonnet-5-5".to_string(),
                    capabilities: vec!["text".to_string()],
                    line: 6,
                },
                Model {
                    name: "haiku".to_string(),
                    provider: "anthropic".to_string(),
                    id: "claude-haiku-5-5".to_string(),
                    capabilities: vec!["text".to_string()],
                    line: 7,
                },
                Model {
                    name: "luna".to_string(),
                    provider: "openai".to_string(),
                    id: "gpt-6-luna".to_string(),
                    capabilities: vec!["text".to_string()],
                    line: 8,
                },
            ],
            system_one: if with_system_one {
                Some(SystemOneSpec {
                    fallback: "haiku".to_string(),
                    student: None,
                    line: 5,
                })
            } else {
                None
            },
            image: None,
            apis: Vec::new(),
            harnesses,
            teams: Vec::new(),
            workflows: Vec::new(),
            outputs: Vec::new(),
        }
    }

    fn one_harness_spec(role: &str, complexity: Option<Complexity>) -> Spec {
        spec_with(
            vec![harness("h1", role, ModelRef::SystemOne, complexity, 12)],
            true,
        )
    }

    #[test]
    fn pinned_resolves_without_calling_picker() {
        let picker = CountingPicker {
            calls: Cell::new(0),
            decision: decision("claude-sonnet-5-5"),
        };
        let spec = spec_with(
            vec![harness(
                "h1",
                "coder",
                ModelRef::Catalog("sonnet".to_string()),
                None,
                12,
            )],
            true,
        );
        let resolved = resolve_all(&spec, &picker).expect("pinned resolves");
        assert_eq!(picker.calls.get(), 0);
        assert_eq!(resolved.len(), 1);
        let r = &resolved[0];
        assert_eq!(r.via, Via::Pinned);
        assert_eq!(r.requested, "sonnet");
        assert_eq!(r.label, "sonnet");
        assert_eq!(r.id, "claude-sonnet-5-5");
        assert_eq!(r.provider_type, "anthropic");
        assert_eq!(r.reason, "pinned in team.yah:12");
        assert_eq!(r.rule, None);
        assert_eq!(r.degraded_level, 0);
        assert_eq!(r.display_model(), "anthropic/claude-sonnet-5-5");
    }

    #[test]
    fn pinned_unknown_label_is_error_at_harness_line() {
        let spec = spec_with(
            vec![harness(
                "h1",
                "coder",
                ModelRef::Catalog("ghost".to_string()),
                None,
                21,
            )],
            true,
        );
        let err = resolve_all(&spec, &ErrPicker).expect_err("unknown pinned label");
        assert_eq!(err.0.len(), 1);
        assert_eq!(err.0[0].line, 21);
        assert!(err.0[0].detail.contains("ghost"));
    }

    #[test]
    fn system_one_success_carries_rule_reason_and_degraded() {
        let spec = one_harness_spec("coder", None);
        let resolved =
            resolve_all(&spec, &FixedPicker(decision("claude-sonnet-5-5"))).expect("pick resolves");
        let r = &resolved[0];
        assert_eq!(r.via, Via::SystemOne);
        assert_eq!(r.requested, "system-one");
        assert_eq!(r.label, "sonnet");
        assert_eq!(r.rule.as_deref(), Some("test-rule"));
        assert_eq!(r.reason, "test reason");
        assert_eq!(r.degraded_level, 2);
    }

    #[test]
    fn system_one_resolved_uses_provider_type_of_chosen_model() {
        let spec = one_harness_spec("coder", None);
        let resolved =
            resolve_all(&spec, &FixedPicker(decision("gpt-6-luna"))).expect("pick resolves");
        assert_eq!(resolved[0].label, "luna");
        assert_eq!(resolved[0].provider_type, "openai");
        assert_eq!(resolved[0].display_model(), "openai/gpt-6-luna");
    }

    #[test]
    fn picker_error_falls_back_with_unavailable_reason() {
        let spec = one_harness_spec("coder", None);
        let resolved = resolve_all(&spec, &ErrPicker).expect("fallback resolves");
        let r = &resolved[0];
        assert_eq!(r.via, Via::Fallback);
        assert_eq!(r.label, "haiku");
        assert_eq!(r.id, "claude-haiku-5-5");
        assert_eq!(r.reason, "system-one unavailable: boom");
        assert_eq!(r.rule, None);
    }

    #[test]
    fn unknown_model_id_falls_back_with_unknown_reason() {
        let spec = one_harness_spec("coder", None);
        let resolved =
            resolve_all(&spec, &FixedPicker(decision("nope-1"))).expect("fallback resolves");
        let r = &resolved[0];
        assert_eq!(r.via, Via::Fallback);
        assert_eq!(r.label, "haiku");
        assert_eq!(r.reason, "system-one chose unknown model nope-1");
        assert_eq!(r.degraded_level, 2);
    }

    #[test]
    fn missing_system_one_block_is_error_with_harness_line() {
        let spec = spec_with(
            vec![harness("solo", "coder", ModelRef::SystemOne, None, 33)],
            false,
        );
        let err = resolve_all(&spec, &ErrPicker).expect_err("no fallback configured");
        assert_eq!(err.0.len(), 1);
        assert_eq!(err.0[0].line, 33);
        assert!(err.0[0].detail.contains("solo"));
        assert!(err.0[0].detail.contains("fallback"));
    }

    #[test]
    fn fallback_label_outside_catalog_is_error() {
        let mut spec = one_harness_spec("coder", None);
        spec.system_one.as_mut().expect("block").fallback = "ghost".to_string();
        let err = resolve_all(&spec, &ErrPicker).expect_err("fallback not in catalog");
        assert_eq!(err.0.len(), 1);
        assert_eq!(err.0[0].line, 12);
    }

    #[test]
    fn identical_requests_are_cached_to_one_picker_call() {
        let picker = CountingPicker {
            calls: Cell::new(0),
            decision: decision("claude-sonnet-5-5"),
        };
        let spec = spec_with(
            vec![
                harness("a", "coder", ModelRef::SystemOne, None, 10),
                harness("b", "coder", ModelRef::SystemOne, None, 11),
            ],
            true,
        );
        let resolved = resolve_all(&spec, &picker).expect("cached resolves");
        assert_eq!(picker.calls.get(), 1);
        assert_eq!(resolved.len(), 2);
        assert_eq!(resolved[0].harness, "a");
        assert_eq!(resolved[1].harness, "b");
        assert_eq!(resolved[0].id, resolved[1].id);
    }

    #[test]
    fn distinct_roles_are_not_cached_together() {
        let picker = CountingPicker {
            calls: Cell::new(0),
            decision: decision("claude-sonnet-5-5"),
        };
        let spec = spec_with(
            vec![
                harness("a", "coder", ModelRef::SystemOne, None, 10),
                harness("b", "planner", ModelRef::SystemOne, None, 11),
            ],
            true,
        );
        resolve_all(&spec, &picker).expect("resolves");
        assert_eq!(picker.calls.get(), 2);
    }

    #[test]
    fn distinct_complexity_is_not_cached_together() {
        let picker = CountingPicker {
            calls: Cell::new(0),
            decision: decision("claude-sonnet-5-5"),
        };
        let spec = spec_with(
            vec![
                harness("a", "coder", ModelRef::SystemOne, Some(Complexity::Low), 10),
                harness("b", "coder", ModelRef::SystemOne, None, 11),
            ],
            true,
        );
        resolve_all(&spec, &picker).expect("resolves");
        assert_eq!(picker.calls.get(), 2);
    }

    #[test]
    fn picker_errors_are_cached_too() {
        let picker = CountingErrPicker {
            calls: Cell::new(0),
        };
        let spec = spec_with(
            vec![
                harness("a", "coder", ModelRef::SystemOne, None, 10),
                harness("b", "coder", ModelRef::SystemOne, None, 11),
            ],
            true,
        );
        let resolved = resolve_all(&spec, &picker).expect("fallback resolves");
        assert_eq!(picker.calls.get(), 1);
        assert!(resolved.iter().all(|r| r.via == Via::Fallback));
    }
    fn recorded_complexity(role: &str, explicit: Option<Complexity>) -> Complexity {
        let picker = RecordingPicker {
            requests: RefCell::new(Vec::new()),
            decision: decision("claude-sonnet-5-5"),
        };
        let spec = one_harness_spec(role, explicit);
        resolve_all(&spec, &picker).expect("resolves");
        let requests = picker.requests.borrow();
        assert_eq!(requests.len(), 1);
        requests[0].complexity
    }

    #[test]
    fn role_researcher_maps_to_low() {
        assert_eq!(recorded_complexity("researcher", None), Complexity::Low);
    }

    #[test]
    fn role_explorer_maps_to_low() {
        assert_eq!(recorded_complexity("explorer", None), Complexity::Low);
    }

    #[test]
    fn role_planner_maps_to_high() {
        assert_eq!(recorded_complexity("planner", None), Complexity::High);
    }

    #[test]
    fn role_reviewer_maps_to_high() {
        assert_eq!(recorded_complexity("reviewer", None), Complexity::High);
    }

    #[test]
    fn role_advisor_maps_to_high() {
        assert_eq!(recorded_complexity("advisor", None), Complexity::High);
    }

    #[test]
    fn other_roles_map_to_medium() {
        assert_eq!(recorded_complexity("coder", None), Complexity::Medium);
    }

    #[test]
    fn explicit_complexity_overrides_role_mapping() {
        assert_eq!(
            recorded_complexity("planner", Some(Complexity::Low)),
            Complexity::Low
        );
    }

    #[test]
    fn request_carries_full_catalog_and_no_images() {
        let picker = RecordingPicker {
            requests: RefCell::new(Vec::new()),
            decision: decision("claude-sonnet-5-5"),
        };
        let spec = one_harness_spec("coder", None);
        resolve_all(&spec, &picker).expect("resolves");
        let requests = picker.requests.borrow();
        let request = &requests[0];
        assert_eq!(request.harness, "h1");
        assert_eq!(request.role, "coder");
        assert!(!request.needs_images);
        let ids: Vec<&str> = request.available.iter().map(|e| e.id.as_str()).collect();
        assert_eq!(
            ids,
            vec!["claude-sonnet-5-5", "claude-haiku-5-5", "gpt-6-luna"]
        );
        let labels: Vec<&str> = request.available.iter().map(|e| e.label.as_str()).collect();
        assert_eq!(labels, vec!["sonnet", "haiku", "luna"]);
        let types: Vec<&str> = request
            .available
            .iter()
            .map(|e| e.provider_type.as_str())
            .collect();
        assert_eq!(types, vec!["anthropic", "anthropic", "openai"]);
    }

    #[test]
    fn declaration_order_is_preserved_across_kinds() {
        let spec = spec_with(
            vec![
                harness(
                    "first",
                    "coder",
                    ModelRef::Catalog("luna".to_string()),
                    None,
                    10,
                ),
                harness("second", "coder", ModelRef::SystemOne, None, 11),
                harness(
                    "third",
                    "coder",
                    ModelRef::Catalog("sonnet".to_string()),
                    None,
                    12,
                ),
            ],
            true,
        );
        let resolved =
            resolve_all(&spec, &FixedPicker(decision("claude-haiku-5-5"))).expect("resolves");
        let names: Vec<&str> = resolved.iter().map(|r| r.harness.as_str()).collect();
        assert_eq!(names, vec!["first", "second", "third"]);
        assert_eq!(resolved[0].via, Via::Pinned);
        assert_eq!(resolved[1].via, Via::SystemOne);
        assert_eq!(resolved[2].via, Via::Pinned);
    }

    #[test]
    fn multiple_unresolvable_harnesses_collect_all_diagnostics() {
        let spec = spec_with(
            vec![
                harness("a", "coder", ModelRef::SystemOne, None, 10),
                harness("b", "planner", ModelRef::SystemOne, None, 20),
            ],
            false,
        );
        let err = resolve_all(&spec, &ErrPicker).expect_err("both fail");
        assert_eq!(err.0.len(), 2);
        assert_eq!(err.0[0].line, 10);
        assert_eq!(err.0[1].line, 20);
    }

    #[test]
    fn locate_system_one_finds_workspace_copy_when_present() {
        match locate_system_one() {
            Some(dir) => assert!(
                is_system_one_dir(&dir),
                "located dir must contain src/system_one"
            ),
            None => eprintln!("skip: packages/system-one not found from this test"),
        }
    }

    #[test]
    fn real_system_one_picker_end_to_end() {
        let Some(dir) = locate_system_one() else {
            eprintln!("skip e2e: system-one directory not found");
            return;
        };
        if std::process::Command::new("python3")
            .arg("--version")
            .output()
            .is_err()
        {
            eprintln!("skip e2e: python3 unavailable");
            return;
        }
        let picker = SystemOnePicker {
            python: "python3".to_string(),
            system_one_dir: dir,
            student: None,
            timeout_ms: 30_000,
        };
        let request = PickRequest {
            harness: "e2e".to_string(),
            role: "coder".to_string(),
            complexity: Complexity::Medium,
            available: vec![
                CatalogEntry {
                    label: "sonnet".to_string(),
                    id: "claude-sonnet-5-5".to_string(),
                    provider_type: "anthropic".to_string(),
                    capabilities: Vec::new(),
                },
                CatalogEntry {
                    label: "haiku".to_string(),
                    id: "claude-haiku-5-5".to_string(),
                    provider_type: "anthropic".to_string(),
                    capabilities: Vec::new(),
                },
                CatalogEntry {
                    label: "luna".to_string(),
                    id: "gpt-6-luna".to_string(),
                    provider_type: "openai".to_string(),
                    capabilities: Vec::new(),
                },
            ],
            needs_images: false,
        };
        let decision = picker.pick(&request).expect("real system-one pick");
        let offered: Vec<&str> = request.available.iter().map(|e| e.id.as_str()).collect();
        assert!(
            offered.contains(&decision.model_id.as_str()),
            "picked {} not in offered catalog",
            decision.model_id
        );
    }
}

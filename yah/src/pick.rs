//! Model resolution: system-one decides `model = "system-one"`.
//!
//! The data types and the `Picker` trait are SHARED CONTRACT (plan.rs and the manifest consume
//! `Resolved`). Rules:
//!   * a harness pinned to a catalog label is `Via::Pinned`; system-one is not asked.
//!   * `model = "system-one"` asks the picker with the catalog as `available` (ids). The answer must be
//!     the id of a catalog model; anything else (error, timeout, python missing, unknown id) uses
//!     `system_one.fallback` (`Via::Fallback`, with the reason). No `system_one` block / no fallback:
//!     that is an error naming the harness and its line. system-one only ever decides `model_pick`;
//!     never route anything else through it.

use std::fs;
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

/// Find `packages/system-one`, in order: `$H1_SYSTEM_ONE_DIR`, `$GRAPHLOOP_SYSTEM_ONE_DIR`,
/// walking up from the `.yah` file, next to the executable (`<exe dir>/system-one`,
/// `<exe dir>/../system-one`, `<exe dir>/../share/h1/system-one`), the path stored in
/// `<config dir>/system-one-dir`, then walking up from the executable and the current
/// directory, looking for `packages/system-one/src/system_one`.
fn is_system_one_dir(path: &Path) -> bool {
    path.join("src").join("system_one").is_dir()
}

fn search_ancestors(start: &Path) -> Option<PathBuf> {
    for ancestor in start.ancestors() {
        if is_system_one_dir(ancestor) && ancestor.ends_with("system-one") {
            return Some(ancestor.to_path_buf());
        }
        let candidate = ancestor.join("packages").join("system-one");
        if is_system_one_dir(&candidate) {
            return Some(candidate);
        }
    }
    None
}

/// Outcome of a system-one search: the directory found (if any), the raw
/// env-override value when one was set but invalid, and a short
/// label for every place that was looked, in search order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SystemOneLocation {
    pub dir: Option<PathBuf>,
    pub env_invalid: Option<String>,
    pub looked: Vec<String>,
}

/// Pure search core (no process env / exe / cwd reads) so tests do not race on env vars.
/// Order: `$H1_SYSTEM_ONE_DIR`, `$GRAPHLOOP_SYSTEM_ONE_DIR`, upward from the `.yah`
/// file, next to the exe, the stored dir, then `extra_starts` (exe, cwd) upward.
pub fn locate_system_one_from(
    h1_env_val: Option<&str>,
    legacy_env_val: Option<&str>,
    yah_file: Option<&Path>,
    exe_dir: Option<&Path>,
    stored_dir: Option<&Path>,
    extra_starts: &[PathBuf],
) -> SystemOneLocation {
    let mut looked: Vec<String> = Vec::new();
    let mut env_invalid: Option<String> = None;
    for (name, raw_opt) in [
        ("H1_SYSTEM_ONE_DIR", h1_env_val),
        ("GRAPHLOOP_SYSTEM_ONE_DIR", legacy_env_val),
    ] {
        if let Some(raw) = raw_opt.filter(|v| !v.is_empty()) {
            looked.push(format!("{name}={raw}"));
            let candidate = PathBuf::from(raw);
            if is_system_one_dir(&candidate) {
                return SystemOneLocation {
                    dir: Some(candidate),
                    env_invalid,
                    looked,
                };
            }
            if env_invalid.is_none() {
                env_invalid = Some(raw.to_string());
            }
        } else {
            looked.push(format!("{name} (unset)"));
        }
    }
    if let Some(yah) = yah_file {
        let start = if yah.is_dir() {
            yah.to_path_buf()
        } else {
            yah.parent().map(|p| p.to_path_buf()).unwrap_or_default()
        };
        if !start.as_os_str().is_empty() {
            looked.push(format!("upward from {}", start.display()));
            if let Some(found) = search_ancestors(&start) {
                return SystemOneLocation {
                    dir: Some(found),
                    env_invalid,
                    looked,
                };
            }
        }
    }
    if let Some(exe_dir) = exe_dir {
        for candidate in [
            exe_dir.join("system-one"),
            exe_dir.join("..").join("system-one"),
            exe_dir
                .join("..")
                .join("share")
                .join("h1")
                .join("system-one"),
        ] {
            looked.push(format!("next to exe: {}", candidate.display()));
            if is_system_one_dir(&candidate) {
                return SystemOneLocation {
                    dir: Some(candidate),
                    env_invalid,
                    looked,
                };
            }
        }
    }
    match stored_dir {
        Some(stored) => {
            looked.push(format!("stored: {}", stored.display()));
            if is_system_one_dir(stored) {
                return SystemOneLocation {
                    dir: Some(stored.to_path_buf()),
                    env_invalid,
                    looked,
                };
            }
        }
        None => looked.push("stored: (none)".to_string()),
    }
    for start in extra_starts {
        looked.push(format!("upward from {}", start.display()));
        if let Some(found) = search_ancestors(start) {
            return SystemOneLocation {
                dir: Some(found),
                env_invalid,
                looked,
            };
        }
    }
    SystemOneLocation {
        dir: None,
        env_invalid,
        looked,
    }
}

/// The h1 config directory: `$H1_CONFIG_DIR`, else `%APPDATA%\\h1` (Windows only),
/// else `$XDG_CONFIG_HOME/h1`, else `~/.config/h1`.
pub fn config_dir() -> Option<PathBuf> {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let app_data = if cfg!(windows) {
        std::env::var("APPDATA").ok()
    } else {
        None
    };
    config_dir_from(
        std::env::var("H1_CONFIG_DIR").ok().as_deref(),
        std::env::var("XDG_CONFIG_HOME").ok().as_deref(),
        app_data.as_deref(),
        home.as_deref(),
    )
}

/// Pure core of `config_dir` (no process env reads) so tests do not race on env vars.
pub fn config_dir_from(
    h1_config_dir: Option<&str>,
    xdg_config_home: Option<&str>,
    app_data: Option<&str>,
    home: Option<&Path>,
) -> Option<PathBuf> {
    if let Some(raw) = h1_config_dir.filter(|v| !v.is_empty()) {
        return Some(PathBuf::from(raw));
    }
    if let Some(raw) = app_data.filter(|v| !v.is_empty()) {
        return Some(PathBuf::from(raw).join("h1"));
    }
    if let Some(raw) = xdg_config_home.filter(|v| !v.is_empty()) {
        return Some(PathBuf::from(raw).join("h1"));
    }
    home.map(|h| h.join(".config").join("h1"))
}

/// File inside the config directory holding the stored system-one path (one line).
const SYSTEM_ONE_DIR_FILE: &str = "system-one-dir";

/// The system-one directory stored by `h1 doctor --set-system-one`, if any.
pub fn stored_system_one_dir() -> Option<PathBuf> {
    config_dir().and_then(|dir| stored_system_one_dir_in(&dir))
}

pub fn stored_system_one_dir_in(config_dir: &Path) -> Option<PathBuf> {
    let text = fs::read_to_string(config_dir.join(SYSTEM_ONE_DIR_FILE)).ok()?;
    let trimmed = text.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(PathBuf::from(trimmed))
    }
}

/// Validate `dir` as a system-one package directory and store it for later picks.
pub fn store_system_one_dir(dir: &Path) -> anyhow::Result<()> {
    let config_dir =
        config_dir().context("cannot find the h1 config directory: set H1_CONFIG_DIR or HOME")?;
    store_system_one_dir_in(&config_dir, dir)
}

pub fn store_system_one_dir_in(config_dir: &Path, dir: &Path) -> anyhow::Result<()> {
    if !is_system_one_dir(dir) {
        anyhow::bail!(
            "{} is not a system-one package directory (no src/system_one)",
            dir.display()
        );
    }
    fs::create_dir_all(config_dir)
        .with_context(|| format!("cannot create config directory {}", config_dir.display()))?;
    let file = config_dir.join(SYSTEM_ONE_DIR_FILE);
    fs::write(&file, format!("{}\n", dir.display()))
        .with_context(|| format!("cannot write {}", file.display()))?;
    Ok(())
}

pub fn locate_system_one_detailed(yah_file: Option<&Path>) -> SystemOneLocation {
    let h1_env_val = std::env::var("H1_SYSTEM_ONE_DIR").ok();
    let legacy_env_val = std::env::var("GRAPHLOOP_SYSTEM_ONE_DIR").ok();
    let mut starts: Vec<PathBuf> = Vec::new();
    let mut exe_dir: Option<PathBuf> = None;
    if let Ok(exe) = std::env::current_exe() {
        exe_dir = exe.parent().map(|p| p.to_path_buf());
        starts.push(exe);
    }
    if let Ok(cwd) = std::env::current_dir() {
        starts.push(cwd);
    }
    let stored = stored_system_one_dir();
    let abs_yah: Option<PathBuf> = yah_file.map(|p| {
        if p.is_absolute() {
            p.to_path_buf()
        } else {
            std::env::current_dir()
                .map(|cwd| cwd.join(p))
                .unwrap_or_else(|_| p.to_path_buf())
        }
    });
    locate_system_one_from(
        h1_env_val.as_deref(),
        legacy_env_val.as_deref(),
        abs_yah.as_deref(),
        exe_dir.as_deref(),
        stored.as_deref(),
        &starts,
    )
}

pub fn locate_system_one() -> Option<PathBuf> {
    locate_system_one_detailed(None).dir
}

/// Exactly one line, used as the fallback reason when system-one cannot be located.
pub fn system_one_not_found_reason(location: &SystemOneLocation) -> String {
    let looked = location.looked.join(", ");
    match &location.env_invalid {
        Some(raw) => format!(
            "system-one not found: env override {raw:?} is not a system-one package directory (no src/system_one); looked in {looked}; set H1_SYSTEM_ONE_DIR (or GRAPHLOOP_SYSTEM_ONE_DIR) to a valid system-one package directory"
        ),
        None => format!(
            "system-one not found: looked in {looked} for packages/system-one; set H1_SYSTEM_ONE_DIR to the system-one package directory"
        ),
    }
}

/// Sample catalog for the doctor sample pick, mirroring `examples/team.yah`.
fn sample_catalog() -> Vec<CatalogEntry> {
    vec![
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
            label: "opus".to_string(),
            id: "claude-opus-5".to_string(),
            provider_type: "anthropic".to_string(),
            capabilities: Vec::new(),
        },
    ]
}

struct UnavailablePicker;
impl Picker for UnavailablePicker {
    fn pick(&self, _request: &PickRequest) -> anyhow::Result<PickDecision> {
        Err(anyhow!("system-one is not available"))
    }
}

/// Two informational lines for `h1 doctor`: where system-one was found (or that
/// it was not, and where was looked), plus a sample pick against the sample
/// catalog (the catalog fallback, `claude-sonnet-5-5`, when the picker fails
/// or chooses an unknown id).
pub fn doctor_report_with(location: &SystemOneLocation, picker: &dyn Picker) -> Vec<String> {
    let first = match &location.dir {
        Some(dir) => format!("system-one: found at {}", dir.display()),
        None => format!(
            "system-one: not found (looked: {})",
            location.looked.join(", ")
        ),
    };
    let available = sample_catalog();
    let request = PickRequest {
        harness: "doctor".to_string(),
        role: "builder".to_string(),
        complexity: Complexity::Medium,
        available: available.clone(),
        needs_images: false,
    };
    let second = match picker.pick(&request) {
        Ok(decision) if available.iter().any(|e| e.id == decision.model_id) => format!(
            "system-one sample pick: {} (via system-one: {} {})",
            decision.model_id, decision.rule, decision.reason
        ),
        Ok(decision) => format!(
            "system-one sample pick: claude-sonnet-5-5 (via fallback: system-one chose unknown model {})",
            decision.model_id
        ),
        Err(e) => format!(
            "system-one sample pick: claude-sonnet-5-5 (via fallback: system-one unavailable: {e})"
        ),
    };
    vec![first, second]
}

/// Doctor lines for the real environment: locate system-one, then sample-pick
/// with the real picker when one was found.
pub fn doctor_report(yah_file: Option<&Path>) -> Vec<String> {
    let location = locate_system_one_detailed(yah_file);
    match &location.dir {
        Some(dir) => {
            let picker = SystemOnePicker {
                python: std::env::var("GRAPHLOOP_PYTHON")
                    .ok()
                    .filter(|v| !v.is_empty())
                    .unwrap_or_else(|| "python3".to_string()),
                system_one_dir: dir.clone(),
                student: None,
                timeout_ms: 10_000,
            };
            doctor_report_with(&location, &picker)
        }
        None => doctor_report_with(&location, &UnavailablePicker),
    }
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
                offset: 0,
                len: 0,
            },
            format!("Could not resolve model for harness \"{}\"", harness.name),
            format!(
                "The model for harness \"{}\" could not be resolved ({reason}), and no usable system_one fallback is configured. Set system_one.fallback to a catalog model label.",
                harness.name
            ),
        )),
    }
}

/// One `Resolved` per harness, in declaration order.
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
                    Span { line: harness.line, col: 1, offset: 0, len: 0 },
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
            vaults: Vec::new(),
            outputs: Vec::new(),
            prototypes: Vec::new(),
            pools: Vec::new(),
            decisions: Vec::new(),
            asks: Vec::new(),
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

    fn make_system_one_tree(root: &Path) -> PathBuf {
        let dir = root.join("packages").join("system-one");
        std::fs::create_dir_all(dir.join("src").join("system_one"))
            .expect("create system-one tree");
        dir
    }

    #[test]
    fn locate_upward_from_yah_finds_packages_system_one() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let want = make_system_one_tree(&tmp.path().join("proj"));
        let yah = tmp.path().join("proj").join("a").join("b").join("team.yah");
        std::fs::create_dir_all(yah.parent().unwrap()).expect("yah dir");
        std::fs::write(&yah, "yah 1\n").expect("yah file");
        let loc = locate_system_one_from(None, None, Some(&yah), None, None, &[]);
        assert_eq!(loc.dir, Some(want));
        assert_eq!(loc.env_invalid, None);
    }

    #[test]
    fn locate_env_override_wins_over_upward_from_yah() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let env_dir = make_system_one_tree(&tmp.path().join("envtree"));
        let _yah_dir = make_system_one_tree(&tmp.path().join("proj"));
        let yah = tmp.path().join("proj").join("nested").join("team.yah");
        std::fs::create_dir_all(yah.parent().unwrap()).expect("yah dir");
        std::fs::write(&yah, "yah 1\n").expect("yah file");
        let loc = locate_system_one_from(
            None,
            Some(&env_dir.to_string_lossy()),
            Some(&yah),
            None,
            None,
            &[],
        );
        assert_eq!(loc.dir, Some(env_dir));
        assert_eq!(loc.env_invalid, None);
    }

    #[test]
    fn locate_env_invalid_is_reported_and_upward_still_applies() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let want = make_system_one_tree(&tmp.path().join("proj"));
        let yah = tmp.path().join("proj").join("nested").join("team.yah");
        std::fs::create_dir_all(yah.parent().unwrap()).expect("yah dir");
        std::fs::write(&yah, "yah 1\n").expect("yah file");
        let bogus = tmp.path().join("no-such-system-one");
        let loc = locate_system_one_from(
            None,
            Some(&bogus.to_string_lossy()),
            Some(&yah),
            None,
            None,
            &[],
        );
        assert_eq!(loc.dir, Some(want));
        assert_eq!(loc.env_invalid, Some(bogus.to_string_lossy().to_string()));
    }

    #[test]
    fn not_found_reason_is_one_line_names_env_var_and_where_looked() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let yah = tmp.path().join("bare").join("team.yah");
        std::fs::create_dir_all(yah.parent().unwrap()).expect("yah dir");
        std::fs::write(&yah, "yah 1\n").expect("yah file");
        let loc = locate_system_one_from(None, None, Some(&yah), None, None, &[]);
        assert_eq!(loc.dir, None);
        let reason = system_one_not_found_reason(&loc);
        assert!(!reason.contains('\n'), "reason must be one line: {reason}");
        assert!(reason.contains("system-one not found"), "{reason}");
        assert!(reason.contains("GRAPHLOOP_SYSTEM_ONE_DIR"), "{reason}");
        assert!(
            reason.contains(&yah.parent().unwrap().to_string_lossy().to_string()),
            "reason must say where it looked: {reason}"
        );
        let bogus = tmp.path().join("bogus");
        let loc2 = locate_system_one_from(
            None,
            Some(&bogus.to_string_lossy()),
            Some(&yah),
            None,
            None,
            &[],
        );
        assert_eq!(loc2.dir, None);
        let reason2 = system_one_not_found_reason(&loc2);
        assert!(!reason2.contains('\n'), "{reason2}");
        assert!(
            reason2.contains("GRAPHLOOP_SYSTEM_ONE_DIR") && reason2.contains("bogus"),
            "invalid env must be named in fallback reason: {reason2}"
        );
    }

    #[test]
    fn locate_h1_env_wins_over_legacy_and_upward() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let h1_dir = make_system_one_tree(&tmp.path().join("h1tree"));
        let legacy_dir = make_system_one_tree(&tmp.path().join("legacytree"));
        let _yah_dir = make_system_one_tree(&tmp.path().join("proj"));
        let yah = tmp.path().join("proj").join("nested").join("team.yah");
        std::fs::create_dir_all(yah.parent().unwrap()).expect("yah dir");
        std::fs::write(&yah, "yah 1\n").expect("yah file");
        let loc = locate_system_one_from(
            Some(&h1_dir.to_string_lossy()),
            Some(&legacy_dir.to_string_lossy()),
            Some(&yah),
            None,
            None,
            &[],
        );
        assert_eq!(loc.dir, Some(h1_dir));
        assert_eq!(loc.env_invalid, None);
    }

    #[test]
    fn locate_h1_env_invalid_falls_through_to_legacy() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let legacy_dir = make_system_one_tree(&tmp.path().join("legacytree"));
        let bogus = tmp.path().join("no-such-system-one");
        let loc = locate_system_one_from(
            Some(&bogus.to_string_lossy()),
            Some(&legacy_dir.to_string_lossy()),
            None,
            None,
            None,
            &[],
        );
        assert_eq!(loc.dir, Some(legacy_dir));
        assert_eq!(loc.env_invalid, Some(bogus.to_string_lossy().to_string()));
    }

    #[test]
    fn locate_exe_sibling_share_dir_is_found() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let exe_dir = tmp.path().join("bin");
        std::fs::create_dir_all(&exe_dir).expect("exe dir");
        let want = tmp.path().join("share").join("h1").join("system-one");
        std::fs::create_dir_all(want.join("src").join("system_one"))
            .expect("share system-one tree");
        let loc = locate_system_one_from(None, None, None, Some(&exe_dir), None, &[]);
        assert_eq!(
            loc.dir,
            Some(
                exe_dir
                    .join("..")
                    .join("share")
                    .join("h1")
                    .join("system-one")
            )
        );
    }

    #[test]
    fn locate_stored_dir_beats_exe_cwd_upward() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let stored = make_system_one_tree(&tmp.path().join("storedtree"));
        let _upward = make_system_one_tree(&tmp.path().join("proj"));
        let start = tmp.path().join("proj").join("nested");
        std::fs::create_dir_all(&start).expect("start dir");
        let loc = locate_system_one_from(None, None, None, None, Some(&stored), &[start]);
        assert_eq!(loc.dir, Some(stored));
    }

    #[test]
    fn config_dir_priority_is_h1_then_appdata_then_xdg_then_home() {
        let home = Path::new("/home/u");
        assert_eq!(
            config_dir_from(Some("/cfg"), Some("/xdg"), Some("/app"), Some(home)),
            Some(PathBuf::from("/cfg"))
        );
        assert_eq!(
            config_dir_from(None, Some("/xdg"), Some("/app"), Some(home)),
            Some(PathBuf::from("/app").join("h1"))
        );
        assert_eq!(
            config_dir_from(None, Some("/xdg"), None, Some(home)),
            Some(PathBuf::from("/xdg").join("h1"))
        );
        assert_eq!(
            config_dir_from(None, None, None, Some(home)),
            Some(home.join(".config").join("h1"))
        );
        assert_eq!(config_dir_from(None, None, None, None), None);
    }

    #[test]
    fn store_and_stored_system_one_dir_round_trip() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let config = tmp.path().join("config");
        let dir = make_system_one_tree(&tmp.path().join("tree"));
        store_system_one_dir_in(&config, &dir).expect("store");
        assert_eq!(stored_system_one_dir_in(&config), Some(dir));
        assert!(
            store_system_one_dir_in(&config, tmp.path()).is_err(),
            "non system-one dir must be rejected"
        );
    }

    #[test]
    fn doctor_report_found_and_not_found_lines() {
        let found = SystemOneLocation {
            dir: Some(PathBuf::from("/x/system-one")),
            env_invalid: None,
            looked: vec![],
        };
        let lines = doctor_report_with(&found, &FixedPicker(decision("claude-haiku-5-5")));
        assert_eq!(lines[0], "system-one: found at /x/system-one");
        assert!(
            lines[1].starts_with("system-one sample pick: claude-haiku-5-5 (via system-one"),
            "{}",
            lines[1]
        );
        let missing = SystemOneLocation {
            dir: None,
            env_invalid: None,
            looked: vec!["H1_SYSTEM_ONE_DIR (unset)".to_string()],
        };
        let lines = doctor_report_with(&missing, &ErrPicker);
        assert_eq!(
            lines[0],
            "system-one: not found (looked: H1_SYSTEM_ONE_DIR (unset))"
        );
        assert!(
            lines[1].starts_with("system-one sample pick: claude-sonnet-5-5 (via fallback"),
            "{}",
            lines[1]
        );
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

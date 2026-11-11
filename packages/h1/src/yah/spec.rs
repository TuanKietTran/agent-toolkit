//! The validated, typed vault. SHARED CONTRACT. Built by `schema::build`, read by `pick`, `plan`
//! and `cli`.
//!
//! Every collection keeps declaration order. `line` fields are the 1-based line of the block, so
//! later stages (pick, plan) can still report `file:line`.

use serde::Serialize;

/// A string that may still contain late-bound parts. Late-bound parts are never expanded into
/// plans, manifests, logs or error messages: [`Templ::display`] keeps them as `${...}`.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize)]
pub struct Templ(pub Vec<Part>);

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub enum Part {
    Lit(String),
    /// `${env.NAME}`: read from the environment only when a lab is actually opened.
    Env(String),
    /// `${harnesses.NAME.model}`: the model `pick` resolved for harness NAME (`provider/id`).
    HarnessModel(String),
    /// `${harnesses.NAME.model_id}`: the bare model id `pick` resolved for harness NAME (no provider prefix).
    HarnessModelId(String),
    /// `${vault.NAME.KEY}`: a secret fetched from the `vault "NAME"` block's provider only when a lab
    /// is opened. Allowed only in `env` maps, so the value reaches the program through its
    /// environment and never through a command line.
    Vault(String, String),
}

pub struct RenderCtx<'a> {
    pub env: &'a dyn Fn(&str) -> Option<String>,
    /// harness name -> `provider/id`
    pub model: &'a dyn Fn(&str) -> Option<String>,
    /// (vault name, key) -> secret value. The error text must never contain a secret.
    pub vault: &'a dyn Fn(&str, &str) -> Result<String, String>,
}

impl Templ {
    pub fn lit(text: &str) -> Templ {
        if text.is_empty() {
            Templ(vec![])
        } else {
            Templ(vec![Part::Lit(text.to_owned())])
        }
    }

    pub fn is_static(&self) -> bool {
        self.0.iter().all(|p| matches!(p, Part::Lit(_)))
    }

    /// True when the text holds a `${vault.*}` part, so it must travel in the environment.
    pub fn has_vault(&self) -> bool {
        self.0.iter().any(|p| matches!(p, Part::Vault(..)))
    }

    /// Text with late-bound parts shown as `${env.NAME}` / `${harnesses.NAME.model}` /
    /// `${vault.NAME.KEY}`. Safe to print.
    pub fn display(&self) -> String {
        self.0
            .iter()
            .map(|p| match p {
                Part::Lit(s) => s.clone(),
                Part::Env(n) => format!("${{env.{n}}}"),
                Part::HarnessModel(h) => format!("${{harnesses.{h}.model}}"),
                Part::HarnessModelId(h) => format!("${{harnesses.{h}.model_id}}"),
                Part::Vault(v, k) => format!("${{vault.{v}.{k}}}"),
            })
            .collect()
    }

    /// Fully expanded text. Fails on an unset variable or an unresolved harness model.
    pub fn render(&self, ctx: &RenderCtx) -> Result<String, String> {
        let mut out = String::new();
        for p in &self.0 {
            match p {
                Part::Lit(s) => out.push_str(s),
                Part::Env(n) => out.push_str(
                    &(ctx.env)(n).ok_or_else(|| format!("environment variable {n} is not set"))?,
                ),
                Part::HarnessModel(h) => out.push_str(
                    &(ctx.model)(h)
                        .ok_or_else(|| format!("no model resolved for harness {h:?}"))?,
                ),
                Part::HarnessModelId(h) => {
                    let full = (ctx.model)(h)
                        .ok_or_else(|| format!("no model resolved for harness {h:?}"))?;
                    out.push_str(full.split_once('/').map(|(_, id)| id).unwrap_or(&full))
                }
                Part::Vault(v, k) => out.push_str(&(ctx.vault)(v, k)?),
            }
        }
        Ok(out)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Complexity {
    Low,
    Medium,
    High,
}

impl Complexity {
    pub fn as_str(self) -> &'static str {
        match self {
            Complexity::Low => "low",
            Complexity::Medium => "medium",
            Complexity::High => "high",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Spec {
    pub version: u32,
    /// File name as given to the loader.
    pub file: String,
    pub variables: Vec<Variable>,
    pub defaults: Defaults,
    pub providers: Vec<Provider>,
    pub vaults: Vec<Vault>,
    pub models: Vec<Model>,
    pub system_one: Option<SystemOne>,
    pub image: Option<Image>,
    pub apis: Vec<Api>,
    pub harnesses: Vec<Harness>,
    pub teams: Vec<Team>,
    pub workflows: Vec<Workflow>,
    pub outputs: Vec<Output>,
}

/// `variable "name" { type, default, description }`. `value` is the effective value after
/// `--var` overrides, as JSON.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Variable {
    pub name: String,
    /// `string` (default) | `number` | `bool` | `list` | `map`
    pub var_type: String,
    pub value: serde_json::Value,
    pub description: Option<String>,
    pub line: u32,
}

/// `defaults { model_policy, sandbox }`
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize)]
pub struct Defaults {
    /// `"system-one"` or a model label. Fills a harness that has no `model`.
    pub model_policy: Option<String>,
    /// `local` | `container`
    pub sandbox: Option<String>,
}

/// `provider "label" { type, api_key, base_url }`. `api_key` must be a bare `env.NAME` reference:
/// secrets are never stored.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Provider {
    pub name: String,
    pub provider_type: String,
    /// The environment variable NAME, not its value.
    pub api_key_env: Option<String>,
    pub base_url: Option<String>,
    pub line: u32,
}

/// `vault "label" { provider, path, account, command, secrets }`: where `${vault.label.KEY}`
/// secrets come from. Holds configuration only, never a value. `provider` selects an adapter in
/// `crate::yah::vault` (`dotenv`, `env`, `command`, ...); `secrets` optionally maps each KEY to the
/// provider-side reference (an `op://` path, a Bitwarden item, a variable name, ...).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Vault {
    pub name: String,
    pub provider: String,
    /// `path`: dotenv file, relative to the `.yah` file.
    pub path: Option<String>,
    /// `account`: provider account or server (for example a 1Password account).
    pub account: Option<String>,
    /// `command`: argv template for the `command` provider; `{ref}` and `{key}` are substituted.
    pub command: Vec<String>,
    /// KEY -> provider-side reference. Empty means any KEY is allowed and the KEY is the reference.
    pub secrets: Vec<(String, String)>,
    pub line: u32,
}

/// `model "label" { provider, id, capabilities }`. `id` is the provider-side model id and
/// defaults to the label. system-one only knows ids from its own catalog (for example
/// `claude-sonnet-5-5`), so a model without a known `id` is never picked by system-one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Model {
    pub name: String,
    pub provider: String,
    pub id: String,
    pub capabilities: Vec<String>,
    pub line: u32,
}

/// `system_one { fallback, student }`
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SystemOne {
    /// Model label used when system-one cannot answer.
    pub fallback: String,
    /// Path of the student model JSON (exported to system-one as `SYSTEM_ONE_STUDENT`).
    pub student: Option<String>,
    pub line: u32,
}

/// `image { provider, generate, vision }`: becomes the tool `image`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Image {
    pub provider: String,
    pub generate: Option<String>,
    pub vision: Option<String>,
    pub line: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ApiType {
    Mcp,
    Http,
}

/// `api "label" { type = "mcp" | "http", command, url, env }`: a tool harnesses can list in `tools`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Api {
    pub name: String,
    pub api_type: ApiType,
    pub command: Vec<Templ>,
    pub url: Option<Templ>,
    pub env: Vec<(String, Templ)>,
    pub line: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub enum ModelRef {
    /// `model = "system-one"`: `pick` decides.
    SystemOne,
    /// `model = "<catalog label>"`: pinned, system-one is not asked.
    Catalog(String),
}

/// `harness "label" { kind, role, parent, model, tools, complexity, open { ... } }`
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Harness {
    pub name: String,
    /// Only `h1` in version 1.
    pub kind: String,
    pub role: String,
    pub parent: Option<String>,
    /// After `defaults.model_policy` was applied.
    pub model: ModelRef,
    /// Labels of `api` blocks, or `image`.
    pub tools: Vec<String>,
    /// Hint for system-one; `None` means pick decides from the role.
    pub complexity: Option<Complexity>,
    pub open: Open,
    pub line: u32,
}

/// `open { command, cols, rows, cwd, env, title, detached, brief, resume_log, auto_rearm }`: the `h1 open` options.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize)]
pub struct Open {
    /// The hosted program and its arguments (everything after `--`). Required, non-empty.
    pub command: Vec<Templ>,
    pub cols: Option<u16>,
    pub rows: Option<u16>,
    pub cwd: Option<Templ>,
    pub env: Vec<(String, Templ)>,
    pub title: Option<Templ>,
    pub detached: bool,
    /// Brief file for renew-with-context (`h1 open --brief`, R40/R41).
    pub brief: Option<Templ>,
    /// Resume/status log file for renew-with-context (`h1 open --resume-log`).
    pub resume_log: Option<Templ>,
    /// Auto re-arm on the session's new-command (`h1 open --auto-rearm`, default off).
    pub auto_rearm: bool,
}

/// `team "label" { root, members, graph }`. Nodes are harnesses; edges are `parent` relations plus
/// `root -> member` for a member without a parent (see `plan::edges`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Team {
    pub name: String,
    pub root: String,
    pub members: Vec<String>,
    /// Draw the graph in the console and lab-gui (default true).
    pub graph: bool,
    pub line: u32,
}

/// `workflow "label" { team, steps }`: recorded and validated, not executed in version 1.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Workflow {
    pub name: String,
    pub team: String,
    pub steps: Vec<String>,
    pub line: u32,
}

/// `output "label" { value, description }`
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Output {
    pub name: String,
    pub value: Templ,
    pub description: Option<String>,
    pub line: u32,
}

impl Spec {
    pub fn harness(&self, name: &str) -> Option<&Harness> {
        self.harnesses.iter().find(|h| h.name == name)
    }
    pub fn model(&self, label: &str) -> Option<&Model> {
        self.models.iter().find(|m| m.name == label)
    }
    pub fn vault(&self, label: &str) -> Option<&Vault> {
        self.vaults.iter().find(|v| v.name == label)
    }
    pub fn provider(&self, label: &str) -> Option<&Provider> {
        self.providers.iter().find(|p| p.name == label)
    }
    pub fn team(&self, name: &str) -> Option<&Team> {
        self.teams.iter().find(|t| t.name == name)
    }
}

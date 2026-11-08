//! Strict schema validation, cross-reference checks and defaults. OWNER: gl-schema.
//!
//! Input: the resolved `ast::File`. Output: `spec::Spec` or all collected `Diagnostics`.

use crate::ast::{Expr, ExprKind, Span, Stmt, StrPart};
use crate::diag::{suggest, Diagnostic, Diagnostics};
use crate::spec::*;
use std::collections::{HashMap, HashSet};

pub const KNOWN_KINDS: &[&str] = &["variable", "defaults", "provider", "vault", "model", "system_one", "image", "api", "harness", "team", "workflow", "output"];
const LABELLED: &[&str] = &["variable", "provider", "vault", "model", "api", "harness", "team", "workflow", "output"];
const SINGLETONS: &[&str] = &["defaults", "system_one", "image"];

type StrRef = (String, Span);
type HarnessRefs = (String, Option<StrRef>, Option<StrRef>, Vec<StrRef>, Span);
type TeamRefs = (String, StrRef, Vec<StrRef>);

struct Cx {
    file: String,
    diags: Diagnostics,
    /// vault label -> declared `secrets` keys (empty: any KEY is allowed). Pre-scanned from the AST.
    vault_keys: HashMap<String, Vec<String>>,
    /// True only while reading an `env` map: `${vault.*}` is allowed there and nowhere else.
    allow_vault: bool,
}

impl Cx {
    fn err(&mut self, at: Span, summary: &str, detail: String, ctx: Option<&str>, hint: Option<String>) {
        let mut d = Diagnostic::error(&self.file, at, summary, detail);
        if let Some(c) = ctx { d = d.with_context(c); }
        if let Some(h) = hint { d = d.with_hint(h); }
        self.diags.push(d);
    }
    fn type_err(&mut self, at: Span, key: &str, expected: &str, ctx: &str) {
        self.err(at, "Incorrect attribute value type", format!("Inappropriate value for attribute \"{key}\": {expected} is required."), Some(ctx), None);
    }
    fn missing(&mut self, at: Span, key: &str, ctx: &str) {
        self.err(at, "Missing required argument", format!("The argument \"{key}\" is required, but no definition was found."), Some(ctx), None);
    }
    fn unsupported(&mut self, at: Span, key: &str, allowed: &[&str], ctx: &str) {
        let hint = suggest(key, allowed.iter().copied()).map(|s| format!("Did you mean \"{s}\"?"));
        self.err(at, "Unsupported argument", format!("An argument named \"{key}\" is not expected here."), Some(ctx), hint);
    }
    fn invalid_value(&mut self, at: Span, key: &str, detail: String, ctx: &str) {
        self.err(at, "Invalid value", detail, Some(ctx), None);
        let _ = key;
    }
    fn late_bound(&mut self, at: Span, key: &str, ctx: &str) {
        self.err(at, "Late-bound value not allowed here", format!("The attribute \"{key}\" must be a static value; late-bound references are not allowed here."), Some(ctx), None);
    }
    fn unknown_ref(&mut self, at: Span, detail: String, target: &str, candidates: &[String], ctx: &str) {
        let hint = suggest(target, candidates.iter().map(String::as_str)).map(|s| format!("Did you mean \"{s}\"?"));
        self.err(at, "Unknown reference", detail, Some(ctx), hint);
    }
}

fn block_ctx(kind: &str, label: Option<&str>) -> String {
    match label {
        Some(l) => format!("{kind} \"{l}\""),
        None => kind.to_string(),
    }
}

fn collect_body<'a>(cx: &mut Cx, block: &'a crate::ast::Block, allowed: &[&str], nested_allowed: &[&str], ctx: &str) -> (HashMap<String, &'a crate::ast::Assign>, Vec<&'a crate::ast::Block>) {
    let mut assigns: HashMap<String, &crate::ast::Assign> = HashMap::new();
    let mut nested: Vec<&crate::ast::Block> = Vec::new();
    for stmt in &block.body {
        match stmt {
            Stmt::Assign(a) => {
                if !allowed.contains(&a.key.as_str()) {
                    cx.unsupported(a.span, &a.key, allowed, ctx);
                } else if assigns.insert(a.key.clone(), a).is_some() {
                    cx.err(a.span, "Duplicate argument", format!("The argument \"{}\" was already defined.", a.key), Some(ctx), None);
                }
            }
            Stmt::Block(b) => {
                if nested_allowed.contains(&b.kind.as_str()) {
                    nested.push(b);
                } else {
                    cx.err(b.span, "Unsupported argument", format!("A block named \"{}\" is not expected here.", b.kind), Some(ctx), None);
                }
            }
        }
    }
    (assigns, nested)
}

fn static_string(cx: &mut Cx, a: &crate::ast::Assign, ctx: &str) -> Option<String> {
    match &a.value.kind {
        ExprKind::Str(parts) => {
            let mut out = String::new();
            for p in parts {
                match p {
                    StrPart::Lit(s) => out.push_str(s),
                    StrPart::Interp(_, span) => { cx.late_bound(*span, &a.key, ctx); return None; }
                }
            }
            Some(out)
        }
        ExprKind::Ref(_) => { cx.late_bound(a.value.span, &a.key, ctx); None }
        _ => { cx.type_err(a.value.span, &a.key, "a string", ctx); None }
    }
}

fn interp_part(cx: &mut Cx, path: &[String], span: Span, harnesses: &[String], key: &str, ctx: &str) -> Option<Part> {
    if path.len() == 2 && path[0] == "env" && !path[1].is_empty() {
        Some(Part::Env(path[1].clone()))
    } else if path.len() == 3 && path[0] == "harnesses" && path[2] == "model" {
        if !harnesses.contains(&path[1]) {
            cx.unknown_ref(span, format!("The reference \"harnesses.{}.model\" names an unknown harness.", path[1]), &path[1], harnesses, ctx);
            return None;
        }
        Some(Part::HarnessModel(path[1].clone()))
    } else if path.len() == 3 && path[0] == "vault" {
        let Some(keys) = cx.vault_keys.get(&path[1]).cloned() else {
            let mut names: Vec<String> = cx.vault_keys.keys().cloned().collect();
            names.sort();
            cx.unknown_ref(span, format!("The reference \"vault.{}.{}\" names a vault that is not declared in this file.", path[1], path[2]), &path[1], &names, ctx);
            return None;
        };
        if !cx.allow_vault {
            cx.err(span, "Vault reference not allowed here", format!("\"${{{}}}\" can only be the value of a key in an \"env\" map. A command line is visible to every process on the machine; an environment variable is not.", path.join(".")), Some(ctx), Some("Put it under env = { NAME = \"${vault.NAME.KEY}\" } and read NAME in the program.".to_owned()));
            return None;
        }
        if !keys.is_empty() && !keys.contains(&path[2]) {
            cx.unknown_ref(span, format!("The vault \"{}\" does not declare a secret named \"{}\".", path[1], path[2]), &path[2], &keys, ctx);
            return None;
        }
        Some(Part::Vault(path[1].clone(), path[2].clone()))
    } else {
        cx.err(span, "Unsupported reference", format!("The reference \"${{{}}}\" is not supported here. Valid references are var.<name>, env.<NAME>, vault.<name>.<KEY> and harnesses.<label>.model.", path.join(".")), Some(ctx), None);
        let _ = key;
        None
    }
}

fn expr_as_templ(cx: &mut Cx, e: &Expr, key: &str, harnesses: &[String], ctx: &str) -> Option<Templ> {
    match &e.kind {
        ExprKind::Str(parts) => {
            let mut out: Vec<Part> = Vec::new();
            for p in parts {
                match p {
                    StrPart::Lit(s) => { if !s.is_empty() { out.push(Part::Lit(s.clone())); } }
                    StrPart::Interp(path, span) => { out.push(interp_part(cx, path, *span, harnesses, key, ctx)?); }
                }
            }
            Some(Templ(out))
        }
        ExprKind::Ref(path) => {
            let part = interp_part(cx, path, e.span, harnesses, key, ctx)?;
            Some(Templ(vec![part]))
        }
        _ => { cx.type_err(e.span, key, "a string", ctx); None }
    }
}

fn string_list(cx: &mut Cx, a: &crate::ast::Assign, ctx: &str) -> Option<Vec<String>> {
    match &a.value.kind {
        ExprKind::List(items) => {
            let mut out = Vec::new();
            for it in items {
                match &it.kind {
                    ExprKind::Str(parts) => {
                        let mut s = String::new();
                        for p in parts {
                            match p {
                                StrPart::Lit(t) => s.push_str(t),
                                StrPart::Interp(_, span) => { cx.late_bound(*span, &a.key, ctx); return None; }
                            }
                        }
                        out.push(s);
                    }
                    ExprKind::Ref(_) => { cx.late_bound(it.span, &a.key, ctx); return None; }
                    _ => { cx.type_err(it.span, &a.key, "a string", ctx); return None; }
                }
            }
            Some(out)
        }
        _ => { cx.type_err(a.value.span, &a.key, "a list", ctx); None }
    }
}

fn templ_list(cx: &mut Cx, a: &crate::ast::Assign, harnesses: &[String], ctx: &str) -> Option<Vec<Templ>> {
    match &a.value.kind {
        ExprKind::List(items) => {
            let mut out = Vec::new();
            for it in items { out.push(expr_as_templ(cx, it, &a.key, harnesses, ctx)?); }
            Some(out)
        }
        _ => { cx.type_err(a.value.span, &a.key, "a list", ctx); None }
    }
}

fn bool_value(cx: &mut Cx, a: &crate::ast::Assign, ctx: &str) -> Option<bool> {
    match &a.value.kind {
        ExprKind::Bool(b) => Some(*b),
        _ => { cx.type_err(a.value.span, &a.key, "a boolean", ctx); None }
    }
}

fn u16_value(cx: &mut Cx, a: &crate::ast::Assign, ctx: &str) -> Option<u16> {
    match &a.value.kind {
        ExprKind::Num(v) => {
            if v.fract() == 0.0 && *v >= 1.0 && *v <= 65535.0 { Some(*v as u16) } else { cx.invalid_value(a.value.span, &a.key, format!("Invalid value for attribute \"{}\": expected an integer between 1 and 65535, got {v}.", a.key), ctx); None }
        }
        _ => { cx.type_err(a.value.span, &a.key, "a number", ctx); None }
    }
}

fn map_templ(cx: &mut Cx, a: &crate::ast::Assign, harnesses: &[String], ctx: &str) -> Option<Vec<(String, Templ)>> {
    match &a.value.kind {
        ExprKind::Map(entries) => {
            let mut out: Vec<(String, Templ)> = Vec::new();
            for e in entries {
                if out.iter().any(|(k, _)| *k == e.key) {
                    cx.err(e.span, "Duplicate argument", format!("The argument \"{}\" was already defined.", e.key), Some(ctx), None);
                    continue;
                }
                let v = expr_as_templ(cx, &e.value, &e.key, harnesses, ctx)?;
                out.push((e.key.clone(), v));
            }
            Some(out)
        }
        _ => { cx.type_err(a.value.span, &a.key, "a map", ctx); None }
    }
}

fn json_value(cx: &mut Cx, e: &Expr, key: &str, ctx: &str) -> Option<serde_json::Value> {
    match &e.kind {
        ExprKind::Str(parts) => {
            let mut s = String::new();
            for p in parts {
                match p {
                    StrPart::Lit(t) => s.push_str(t),
                    StrPart::Interp(_, span) => { cx.late_bound(*span, key, ctx); return None; }
                }
            }
            Some(serde_json::Value::String(s))
        }
        ExprKind::Num(v) => {
            if v.fract() == 0.0 && *v >= -9.0e15 && *v <= 9.0e15 { Some(serde_json::json!(*v as i64)) } else { serde_json::Number::from_f64(*v).map(serde_json::Value::Number) }
        }
        ExprKind::Bool(b) => Some(serde_json::Value::Bool(*b)),
        ExprKind::Null => Some(serde_json::Value::Null),
        ExprKind::List(items) => {
            let mut out = Vec::new();
            for it in items { out.push(json_value(cx, it, key, ctx)?); }
            Some(serde_json::Value::Array(out))
        }
        ExprKind::Map(entries) => {
            let mut map = serde_json::Map::new();
            for en in entries { let v = json_value(cx, &en.value, key, ctx)?; map.insert(en.key.clone(), v); }
            Some(serde_json::Value::Object(map))
        }
        ExprKind::Ref(_) => { cx.late_bound(e.span, key, ctx); None }
    }
}

fn enum_value(cx: &mut Cx, a: &crate::ast::Assign, allowed: &[&str], ctx: &str) -> Option<String> {
    let v = static_string(cx, a, ctx)?;
    if allowed.contains(&v.as_str()) { Some(v) } else {
        let list = allowed.iter().map(|s| format!("\\\"{s}\\\"")).collect::<Vec<_>>().join(", ");
        cx.invalid_value(a.value.span, &a.key, format!("Invalid value for attribute \"{}\": expected one of {list}, got \\\"{v}\\\".", a.key), ctx);
        None
    }
}

pub fn build(file: &crate::ast::File) -> Result<Spec, Diagnostics> {
    let mut cx = Cx { file: file.name.clone(), diags: Diagnostics::default(), vault_keys: prescan_vaults(file), allow_vault: false };
    let mut spec = Spec { version: file.version, file: file.name.clone(), variables: Vec::new(), defaults: Defaults::default(), providers: Vec::new(), vaults: Vec::new(), models: Vec::new(), system_one: None, image: None, apis: Vec::new(), harnesses: Vec::new(), teams: Vec::new(), workflows: Vec::new(), outputs: Vec::new() };
    let mut declared: HashMap<String, Vec<String>> = HashMap::new();
    for stmt in &file.stmts {
        if let Stmt::Block(b) = stmt
            && let Some(l) = &b.label { declared.entry(b.kind.clone()).or_default().push(l.clone()); }
    }
    let harness_labels: Vec<String> = declared.get("harness").cloned().unwrap_or_default();
    let mut seen_labelled: HashSet<(String, String)> = HashSet::new();
    let mut seen_single: HashSet<String> = HashSet::new();
    let mut model_refs: Vec<(String, String, Span)> = Vec::new();
    let mut defaults_policy: Option<(String, Span)> = None;
    let mut system_one_ref: Option<(String, Span)> = None;
    let mut image_ref: Option<(String, Span)> = None;
    let mut harness_refs: Vec<HarnessRefs> = Vec::new();
    let mut team_refs: Vec<TeamRefs> = Vec::new();
    let mut workflow_refs: Vec<(String, (String, Span))> = Vec::new();
    // MARKER_STATE
    for stmt in &file.stmts {
        match stmt {
            Stmt::Assign(a) => {
                cx.err(a.span, "Unsupported argument", format!("An argument named \"{}\" is not expected here.", a.key), None, None);
            }
            Stmt::Block(block) => {
                let kind = block.kind.as_str();
                if !KNOWN_KINDS.contains(&kind) {
                    let hint = suggest(kind, KNOWN_KINDS.iter().copied()).map(|s| format!("Did you mean \"{s}\"?"));
                    cx.err(block.span, "Unknown block kind", format!("The block kind \"{kind}\" is not supported."), None, hint);
                    continue;
                }
                if SINGLETONS.contains(&kind) && !seen_single.insert(kind.to_string()) {
                    cx.err(block.span, "Duplicate block", format!("Only one \"{kind}\" block is allowed."), Some(&block_ctx(kind, None)), None);
                    continue;
                }
                if let Some(l) = &block.label
                    && !seen_labelled.insert((kind.to_string(), l.clone())) {
                        cx.err(block.span, "Duplicate block", format!("A \"{kind}\" block labelled \"{l}\" is already defined."), Some(&block_ctx(kind, Some(l))), None);
                        continue;
                    }
                if LABELLED.contains(&kind) && block.label.is_none() {
                    cx.err(block.span, "Missing label", format!("The block \"{kind}\" requires a label."), Some(kind), None);
                    continue;
                }
                if !LABELLED.contains(&kind) && block.label.is_some() {
                    cx.err(block.span, "Unexpected label", format!("The block \"{kind}\" does not take a label."), Some(kind), None);
                    continue;
                }
                match kind {
                    "variable" => parse_variable(&mut cx, block, &mut spec),
                    "defaults" => { if let Some(p) = parse_defaults(&mut cx, block, &mut spec) { defaults_policy = Some(p); } }
                    "provider" => parse_provider(&mut cx, block, &mut spec),
                    "vault" => parse_vault(&mut cx, block, &mut spec),
                    "model" => { if let Some(r) = parse_model(&mut cx, block, &mut spec) { model_refs.push(r); } }
                    "system_one" => { if let Some(r) = parse_system_one(&mut cx, block, &mut spec) { system_one_ref = Some(r); } }
                    "image" => { if let Some(r) = parse_image(&mut cx, block, &mut spec) { image_ref = Some(r); } }
                    "api" => parse_api(&mut cx, block, &mut spec, &harness_labels),
                    "harness" => { if let Some(r) = parse_harness(&mut cx, block, &mut spec, &harness_labels) { harness_refs.push(r); } }
                    "team" => { if let Some(r) = parse_team(&mut cx, block, &mut spec) { team_refs.push(r); } }
                    "workflow" => { if let Some(r) = parse_workflow(&mut cx, block, &mut spec) { workflow_refs.push(r); } }
                    "output" => parse_output(&mut cx, block, &mut spec, &harness_labels),
                    // MARKER_DISPATCH
                    _ => {}
                }
            }
        }
    }
    // Finalize: cross-reference validation + defaults application.
    let provider_labels: Vec<String> = spec.providers.iter().map(|p| p.name.clone()).collect();
    let model_labels: Vec<String> = spec.models.iter().map(|m| m.name.clone()).collect();
    let api_labels: Vec<String> = spec.apis.iter().map(|a| a.name.clone()).collect();
    let harness_labels2: Vec<String> = spec.harnesses.iter().map(|h| h.name.clone()).collect();
    let team_labels: Vec<String> = spec.teams.iter().map(|t| t.name.clone()).collect();
    if let Some((v, span)) = &defaults_policy {
        if v != "system-one" && !model_labels.contains(v) {
            cx.unknown_ref(*span, format!("The defaults model_policy refers to an unknown model \"{v}\"."), v, &model_labels, "defaults");
        } else if v != "system-one" {
            let no_model: Vec<String> = harness_refs.iter().filter(|(_, _, m, _, _)| m.is_none()).map(|(l, _, _, _, _)| l.clone()).collect();
            for h in spec.harnesses.iter_mut() { if no_model.contains(&h.name) { h.model = ModelRef::Catalog(v.clone()); } }
        }
    }
    for (label, prov, span) in &model_refs {
        if !provider_labels.contains(prov) { cx.unknown_ref(*span, format!("The model \"{label}\" refers to an unknown provider \"{prov}\"."), prov, &provider_labels, &block_ctx("model", Some(label))); }
    }
    if let Some((v, span)) = &system_one_ref
        && !model_labels.contains(v) { cx.unknown_ref(*span, format!("The system_one fallback refers to an unknown model \"{v}\"."), v, &model_labels, "system_one"); }
    if let Some((v, span)) = &image_ref
        && !provider_labels.contains(v) { cx.unknown_ref(*span, format!("The image block refers to an unknown provider \"{v}\"."), v, &provider_labels, "image"); }
    for (label, parent_ref, model_raw, tools_refs, span) in &harness_refs {
        let ctx = block_ctx("harness", Some(label));
        if let Some((p, s)) = parent_ref
            && !harness_labels2.contains(p) { cx.unknown_ref(*s, format!("The harness \"{label}\" refers to an unknown parent harness \"{p}\"."), p, &harness_labels2, &ctx); }
        if let Some((m, s)) = model_raw
            && m != "system-one" && !model_labels.contains(m) { cx.unknown_ref(*s, format!("The harness \"{label}\" refers to an unknown model \"{m}\"."), m, &model_labels, &ctx); }
        for (t, s) in tools_refs {
            if t != "image" && !api_labels.contains(t) { let mut cands = api_labels.clone(); cands.push("image".to_string()); cx.unknown_ref(*s, format!("The harness \"{label}\" refers to an unknown tool \"{t}\"."), t, &cands, &ctx); }
        }
        let parent_map: std::collections::HashMap<String, String> = spec.harnesses.iter().filter_map(|h| h.parent.clone().map(|p| (h.name.clone(), p))).collect();
        let mut visited: HashSet<String> = HashSet::new();
        let mut cur = label.clone();
        visited.insert(cur.clone());
        while let Some(p) = parent_map.get(&cur) { if !visited.insert(p.clone()) { cx.err(*span, "Cycle detected", format!("The parent chain of harness \"{label}\" contains a cycle."), Some(&ctx), None); break; } cur = p.clone(); }
    }
    for (label, (root, root_span), members) in &team_refs {
        let ctx = block_ctx("team", Some(label));
        if !harness_labels2.contains(root) { cx.unknown_ref(*root_span, format!("The team \"{label}\" refers to an unknown root harness \"{root}\"."), root, &harness_labels2, &ctx); }
        for (m, s) in members {
            if !harness_labels2.contains(m) { cx.unknown_ref(*s, format!("The team \"{label}\" refers to an unknown member harness \"{m}\"."), m, &harness_labels2, &ctx); }
        }
    }
    for (label, (team, span)) in &workflow_refs {
        if !team_labels.contains(team) { cx.unknown_ref(*span, format!("The workflow \"{label}\" refers to an unknown team \"{team}\"."), team, &team_labels, &block_ctx("workflow", Some(label))); }
    }
    cx.diags.0.sort_by_key(|d| (d.line, d.col));
    cx.diags.into_result(spec)
}

fn parse_variable(cx: &mut Cx, block: &crate::ast::Block, spec: &mut Spec) {
    let label = block.label.clone().unwrap_or_default();
    let ctx = block_ctx("variable", Some(&label));
    let (assigns, _) = collect_body(cx, block, &["type", "default", "description"], &[], &ctx);
    let mut var_type = "string".to_string();
    if let Some(a) = assigns.get("type")
        && let Some(v) = enum_value(cx, a, &["string", "number", "bool", "list", "map"], &ctx) { var_type = v; }
    let mut value = serde_json::Value::Null;
    if let Some(a) = assigns.get("default") {
        if let Some(v) = json_value(cx, &a.value, "default", &ctx) {
            let ok = matches!((var_type.as_str(), &v), ("string", serde_json::Value::String(_)) | ("number", serde_json::Value::Number(_)) | ("bool", serde_json::Value::Bool(_)) | ("list", serde_json::Value::Array(_)) | ("map", serde_json::Value::Object(_)));
            if !ok { cx.type_err(a.value.span, "default", match var_type.as_str() { "string" => "a string", "number" => "a number", "bool" => "a boolean", "list" => "a list", _ => "a map" }, &ctx); }
            value = v;
        }
    } else {
        cx.missing(block.span, "default", &ctx);
    }
    let description = assigns.get("description").and_then(|a| static_string(cx, a, &ctx));
    spec.variables.push(Variable { name: label, var_type, value, description, line: block.span.line });
}
fn parse_defaults(cx: &mut Cx, block: &crate::ast::Block, spec: &mut Spec) -> Option<(String, Span)> {
    let ctx = block_ctx("defaults", None);
    let (assigns, _) = collect_body(cx, block, &["model_policy", "sandbox"], &[], &ctx);
    let mut policy = None;
    if let Some(a) = assigns.get("model_policy")
        && let Some(v) = static_string(cx, a, &ctx) { spec.defaults.model_policy = Some(v.clone()); policy = Some((v, a.span)); }
    if let Some(a) = assigns.get("sandbox") {
        spec.defaults.sandbox = enum_value(cx, a, &["local", "container"], &ctx);
    }
    policy
}

fn api_key_value(cx: &mut Cx, a: &crate::ast::Assign, ctx: &str) -> Option<String> {
    match &a.value.kind {
        ExprKind::Ref(path) if path.len() == 2 && path[0] == "env" && !path[1].is_empty() => Some(path[1].clone()),
        ExprKind::Str(parts) if parts.len() == 1 => {
            match &parts[0] {
                StrPart::Interp(path, _) if path.len() == 2 && path[0] == "env" && !path[1].is_empty() => Some(path[1].clone()),
                _ => { cx.err(a.value.span, "Secrets are never stored", "The argument \"api_key\" must be a bare env.NAME reference.".to_string(), Some(ctx), Some("Use env.NAME instead.".to_string())); None }
            }
        }
        ExprKind::Str(_) => { cx.err(a.value.span, "Secrets are never stored", "The argument \"api_key\" must be a bare env.NAME reference.".to_string(), Some(ctx), Some("Use env.NAME instead.".to_string())); None }
        _ => { cx.type_err(a.value.span, "api_key", "an env.NAME reference", ctx); None }
    }
}

fn parse_provider(cx: &mut Cx, block: &crate::ast::Block, spec: &mut Spec) {
    let label = block.label.clone().unwrap_or_default();
    let ctx = block_ctx("provider", Some(&label));
    let (assigns, _) = collect_body(cx, block, &["type", "api_key", "base_url"], &[], &ctx);
    let provider_type = match assigns.get("type") {
        Some(a) => static_string(cx, a, &ctx),
        None => { cx.missing(block.span, "type", &ctx); None }
    };
    let api_key_env = assigns.get("api_key").and_then(|a| api_key_value(cx, a, &ctx));
    let base_url = assigns.get("base_url").and_then(|a| static_string(cx, a, &ctx));
    spec.providers.push(Provider { name: label, provider_type: provider_type.unwrap_or_default(), api_key_env, base_url, line: block.span.line });
}

/// Vault label -> the KEYs of its `secrets` map, read straight from the AST so references can be
/// checked before the vault block itself is validated.
fn prescan_vaults(file: &crate::ast::File) -> HashMap<String, Vec<String>> {
    let mut out = HashMap::new();
    for stmt in &file.stmts {
        if let Stmt::Block(b) = stmt
            && b.kind == "vault"
            && let Some(label) = &b.label
        {
            let keys = match b.assign("secrets").map(|a| &a.value.kind) {
                Some(ExprKind::Map(entries)) => entries.iter().map(|e| e.key.clone()).collect(),
                _ => Vec::new(),
            };
            out.insert(label.clone(), keys);
        }
    }
    out
}

fn parse_vault(cx: &mut Cx, block: &crate::ast::Block, spec: &mut Spec) {
    let label = block.label.clone().unwrap_or_default();
    let ctx = block_ctx("vault", Some(&label));
    let (assigns, _) = collect_body(cx, block, &["provider", "path", "account", "command", "secrets"], &[], &ctx);
    let provider = match assigns.get("provider") {
        Some(a) => static_string(cx, a, &ctx).map(|p| (p, a.value.span)),
        None => { cx.missing(block.span, "provider", &ctx); None }
    };
    let mut info = None;
    if let Some((p, span)) = &provider {
        match crate::vault::provider(p) {
            Some(i) => info = Some(i),
            None => {
                let names: Vec<String> = crate::vault::provider_names().into_iter().map(str::to_owned).collect();
                let hint = suggest(p, names.iter().map(String::as_str)).map(|s| format!("Did you mean \"{s}\"?"));
                cx.err(*span, "Unknown vault provider", format!("The vault provider \"{p}\" is not supported. Available: {}.", names.join(", ")), Some(&ctx), hint);
            }
        }
    }
    if let Some(info) = info {
        for key in ["path", "account", "command"] {
            if let Some(a) = assigns.get(key)
                && !info.keys.contains(&key)
            {
                let accepted = if info.keys.is_empty() { "no extra arguments".to_owned() } else { info.keys.join(", ") };
                cx.err(a.span, "Unsupported argument", format!("The argument \"{key}\" is not used by the \"{}\" provider, which accepts {accepted}.", info.name), Some(&ctx), None);
            }
        }
        for key in info.required {
            if !assigns.contains_key(*key) { cx.missing(block.span, key, &ctx); }
        }
    }
    let path = assigns.get("path").and_then(|a| static_string(cx, a, &ctx));
    let account = assigns.get("account").and_then(|a| static_string(cx, a, &ctx));
    let command = assigns.get("command").and_then(|a| string_list(cx, a, &ctx));
    if let (Some(a), Some(list)) = (assigns.get("command"), &command)
        && list.is_empty()
    {
        cx.invalid_value(a.value.span, "command", "Invalid value for attribute \"command\": expected a non-empty list.".to_string(), &ctx);
    }
    let mut secrets: Vec<(String, String)> = Vec::new();
    if let Some(a) = assigns.get("secrets") {
        match &a.value.kind {
            ExprKind::Map(entries) => {
                for e in entries {
                    if secrets.iter().any(|(k, _)| *k == e.key) {
                        cx.err(e.span, "Duplicate argument", format!("The secret \"{}\" was already defined.", e.key), Some(&ctx), None);
                        continue;
                    }
                    if let Some(reference) = static_string(cx, e, &ctx) {
                        let name_like = !reference.is_empty() && reference.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'));
                        if matches!(info.map(|i| i.name), Some("dotenv" | "env")) && !name_like {
                            cx.err(e.value.span, "Secrets are never stored", format!("The reference for \"{}\" must be the name of a variable in the {} source, not a value.", e.key, info.map(|i| i.name).unwrap_or("vault")), Some(&ctx), Some("Write the variable name here and keep the value in the .env file or the vault.".to_owned()));
                            continue;
                        }
                        secrets.push((e.key.clone(), reference));
                    }
                }
            }
            _ => cx.type_err(a.value.span, "secrets", "a map", &ctx),
        }
    }
    spec.vaults.push(Vault { name: label, provider: provider.map(|(p, _)| p).unwrap_or_default(), path, account, command: command.unwrap_or_default(), secrets, line: block.span.line });
}

fn parse_model(cx: &mut Cx, block: &crate::ast::Block, spec: &mut Spec) -> Option<(String, String, Span)> {
    let label = block.label.clone().unwrap_or_default();
    let ctx = block_ctx("model", Some(&label));
    let (assigns, _) = collect_body(cx, block, &["provider", "id", "capabilities"], &[], &ctx);
    let mut provider_ref = None;
    let provider = match assigns.get("provider") {
        Some(a) => { let v = static_string(cx, a, &ctx); if let Some(s) = &v { provider_ref = Some((label.clone(), s.clone(), a.span)); } v }
        None => { cx.missing(block.span, "provider", &ctx); None }
    };
    let id = assigns.get("id").and_then(|a| static_string(cx, a, &ctx)).unwrap_or_else(|| label.clone());
    let capabilities = assigns.get("capabilities").and_then(|a| string_list(cx, a, &ctx)).unwrap_or_default();
    spec.models.push(Model { name: label, provider: provider.unwrap_or_default(), id, capabilities, line: block.span.line });
    provider_ref
}
fn parse_system_one(cx: &mut Cx, block: &crate::ast::Block, spec: &mut Spec) -> Option<(String, Span)> {
    let ctx = block_ctx("system_one", None);
    let (assigns, _) = collect_body(cx, block, &["fallback", "student"], &[], &ctx);
    let mut fallback_ref = None;
    let fallback = match assigns.get("fallback") {
        Some(a) => { let v = static_string(cx, a, &ctx); if let Some(s) = &v { fallback_ref = Some((s.clone(), a.span)); } v }
        None => { cx.missing(block.span, "fallback", &ctx); None }
    };
    let student = assigns.get("student").and_then(|a| static_string(cx, a, &ctx));
    spec.system_one = Some(SystemOne { fallback: fallback.unwrap_or_default(), student, line: block.span.line });
    fallback_ref
}
fn parse_image(cx: &mut Cx, block: &crate::ast::Block, spec: &mut Spec) -> Option<(String, Span)> {
    let ctx = block_ctx("image", None);
    let (assigns, _) = collect_body(cx, block, &["provider", "generate", "vision"], &[], &ctx);
    let mut provider_ref = None;
    let provider = match assigns.get("provider") {
        Some(a) => { let v = static_string(cx, a, &ctx); if let Some(s) = &v { provider_ref = Some((s.clone(), a.span)); } v }
        None => { cx.missing(block.span, "provider", &ctx); None }
    };
    let generate = assigns.get("generate").and_then(|a| static_string(cx, a, &ctx));
    let vision = assigns.get("vision").and_then(|a| static_string(cx, a, &ctx));
    spec.image = Some(Image { provider: provider.unwrap_or_default(), generate, vision, line: block.span.line });
    provider_ref
}
fn parse_api(cx: &mut Cx, block: &crate::ast::Block, spec: &mut Spec, harnesses: &[String]) {
    let label = block.label.clone().unwrap_or_default();
    let ctx = block_ctx("api", Some(&label));
    let (assigns, _) = collect_body(cx, block, &["type", "command", "url", "env"], &[], &ctx);
    let api_type = match assigns.get("type") {
        Some(a) => enum_value(cx, a, &["mcp", "http"], &ctx),
        None => { cx.missing(block.span, "type", &ctx); None }
    };
    let mut command: Vec<Templ> = Vec::new();
    let mut url: Option<Templ> = None;
    match api_type.as_deref() {
        Some("mcp") => {
            match assigns.get("command") {
                Some(a) => {
                    if let Some(list) = templ_list(cx, a, harnesses, &ctx) {
                        if list.is_empty() { cx.invalid_value(a.value.span, "command", "Invalid value for attribute \"command\": expected a non-empty list.".to_string(), &ctx); }
                        command = list;
                    }
                }
                None => { cx.missing(block.span, "command", &ctx); }
            }
            if let Some(a) = assigns.get("url") { url = expr_as_templ(cx, &a.value, "url", harnesses, &ctx); }
        }
        Some("http") => {
            match assigns.get("url") {
                Some(a) => { url = expr_as_templ(cx, &a.value, "url", harnesses, &ctx); }
                None => { cx.missing(block.span, "url", &ctx); }
            }
            if let Some(a) = assigns.get("command") && let Some(list) = templ_list(cx, a, harnesses, &ctx) { command = list; }
        }
        _ => {}
    }
    cx.allow_vault = true;
    let env = assigns.get("env").and_then(|a| map_templ(cx, a, harnesses, &ctx)).unwrap_or_default();
    cx.allow_vault = false;
    spec.apis.push(Api { name: label, api_type: if api_type.as_deref() == Some("http") { ApiType::Http } else { ApiType::Mcp }, command, url, env, line: block.span.line });
}
fn parse_open(cx: &mut Cx, block: &crate::ast::Block, harnesses: &[String], hctx: &str) -> Open {
    let ctx = format!("{hctx} > open");
    let (assigns, _) = collect_body(cx, block, &["command", "cols", "rows", "cwd", "env", "title", "detached"], &[], &ctx);
    let mut command: Vec<Templ> = Vec::new();
    match assigns.get("command") {
        Some(a) => {
            if let Some(list) = templ_list(cx, a, harnesses, &ctx) {
                if list.is_empty() { cx.invalid_value(a.value.span, "command", "Invalid value for attribute \"command\": expected a non-empty list.".to_string(), &ctx); }
                command = list;
            }
        }
        None => { cx.missing(block.span, "command", &ctx); }
    }
    let cols = assigns.get("cols").and_then(|a| u16_value(cx, a, &ctx));
    let rows = assigns.get("rows").and_then(|a| u16_value(cx, a, &ctx));
    let cwd = assigns.get("cwd").and_then(|a| expr_as_templ(cx, &a.value, "cwd", harnesses, &ctx));
    cx.allow_vault = true;
    let env = assigns.get("env").and_then(|a| map_templ(cx, a, harnesses, &ctx)).unwrap_or_default();
    cx.allow_vault = false;
    let title = assigns.get("title").and_then(|a| expr_as_templ(cx, &a.value, "title", harnesses, &ctx));
    let detached = assigns.get("detached").and_then(|a| bool_value(cx, a, &ctx)).unwrap_or(false);
    Open { command, cols, rows, cwd, env, title, detached }
}
fn parse_harness(cx: &mut Cx, block: &crate::ast::Block, spec: &mut Spec, harnesses: &[String]) -> Option<HarnessRefs> {
    let label = block.label.clone().unwrap_or_default();
    let ctx = block_ctx("harness", Some(&label));
    let (assigns, nested) = collect_body(cx, block, &["kind", "role", "parent", "model", "tools", "complexity"], &["open"], &ctx);
    let kind = match assigns.get("kind") {
        Some(a) => {
            let v = static_string(cx, a, &ctx);
            if let Some(s) = &v
                && s != "h1" { cx.invalid_value(a.value.span, "kind", format!("Invalid value for attribute \"kind\": expected \"h1\", got \"{s}\"."), &ctx); }
            v
        }
        None => { cx.missing(block.span, "kind", &ctx); None }
    };
    let role = match assigns.get("role") {
        Some(a) => static_string(cx, a, &ctx),
        None => { cx.missing(block.span, "role", &ctx); None }
    };
    let mut parent_ref = None;
    let parent = match assigns.get("parent") {
        Some(a) => { let v = static_string(cx, a, &ctx); if let Some(s) = &v { parent_ref = Some((s.clone(), a.span)); } v }
        None => None
    };
    let mut model_raw = None;
    let model_str = match assigns.get("model") {
        Some(a) => { let v = static_string(cx, a, &ctx); if let Some(s) = &v { model_raw = Some((s.clone(), a.span)); } v }
        None => None
    };
    let model = match model_str.as_deref() {
        Some("system-one") | None => ModelRef::SystemOne,
        Some(other) => ModelRef::Catalog(other.to_string()),
    };
    let mut tools_refs: Vec<(String, Span)> = Vec::new();
    let tools = match assigns.get("tools") {
        Some(a) => { let v = string_list(cx, a, &ctx).unwrap_or_default(); for t in &v { tools_refs.push((t.clone(), a.span)); } v }
        None => Vec::new()
    };
    let complexity = assigns.get("complexity").and_then(|a| enum_value(cx, a, &["low", "medium", "high"], &ctx)).map(|s| match s.as_str() { "low" => Complexity::Low, "medium" => Complexity::Medium, _ => Complexity::High });
    let open = match nested.len() {
        0 => { cx.missing(block.span, "open", &ctx); Open::default() }
        _ => {
            for extra in &nested[1..] { cx.err(extra.span, "Duplicate block", "Only one \"open\" block is allowed.".to_string(), Some(&ctx), None); }
            parse_open(cx, nested[0], harnesses, &ctx)
        }
    };
    spec.harnesses.push(Harness { name: label.clone(), kind: kind.unwrap_or_default(), role: role.unwrap_or_default(), parent, model, tools, complexity, open, line: block.span.line });
    Some((label, parent_ref, model_raw, tools_refs, block.span))
}
fn parse_team(cx: &mut Cx, block: &crate::ast::Block, spec: &mut Spec) -> Option<TeamRefs> {
    let label = block.label.clone().unwrap_or_default();
    let ctx = block_ctx("team", Some(&label));
    let (assigns, _) = collect_body(cx, block, &["root", "members", "graph"], &[], &ctx);
    let mut root_ref = None;
    let root = match assigns.get("root") {
        Some(a) => { let v = static_string(cx, a, &ctx); if let Some(s) = &v { root_ref = Some((s.clone(), a.span)); } v }
        None => { cx.missing(block.span, "root", &ctx); None }
    };
    let mut member_refs: Vec<(String, Span)> = Vec::new();
    let members = match assigns.get("members") {
        Some(a) => { let v = string_list(cx, a, &ctx).unwrap_or_default(); for m in &v { member_refs.push((m.clone(), a.span)); } v }
        None => Vec::new()
    };
    let graph = assigns.get("graph").and_then(|a| bool_value(cx, a, &ctx)).unwrap_or(true);
    spec.teams.push(Team { name: label.clone(), root: root.unwrap_or_default(), members, graph, line: block.span.line });
    root_ref.map(|r| (label, r, member_refs))
}
fn parse_workflow(cx: &mut Cx, block: &crate::ast::Block, spec: &mut Spec) -> Option<(String, (String, Span))> {
    let label = block.label.clone().unwrap_or_default();
    let ctx = block_ctx("workflow", Some(&label));
    let (assigns, _) = collect_body(cx, block, &["team", "steps"], &[], &ctx);
    let mut team_ref = None;
    let team = match assigns.get("team") {
        Some(a) => { let v = static_string(cx, a, &ctx); if let Some(s) = &v { team_ref = Some((s.clone(), a.span)); } v }
        None => { cx.missing(block.span, "team", &ctx); None }
    };
    let steps = match assigns.get("steps") {
        Some(a) => string_list(cx, a, &ctx).unwrap_or_default(),
        None => { cx.missing(block.span, "steps", &ctx); Vec::new() }
    };
    spec.workflows.push(Workflow { name: label.clone(), team: team.unwrap_or_default(), steps, line: block.span.line });
    team_ref.map(|r| (label, r))
}
fn parse_output(cx: &mut Cx, block: &crate::ast::Block, spec: &mut Spec, harnesses: &[String]) {
    let label = block.label.clone().unwrap_or_default();
    let ctx = block_ctx("output", Some(&label));
    let (assigns, _) = collect_body(cx, block, &["value", "description"], &[], &ctx);
    let value = match assigns.get("value") {
        Some(a) => match &a.value.kind {
            ExprKind::Str(_) | ExprKind::Ref(_) => expr_as_templ(cx, &a.value, "value", harnesses, &ctx),
            _ => match json_value(cx, &a.value, "value", &ctx) {
                Some(v) if v.is_number() || v.is_boolean() => Some(crate::spec::Templ::lit(&v.to_string())),
                Some(_) => { cx.type_err(a.value.span, "value", "a string, number, bool or reference", &ctx); None }
                None => None,
            },
        },
        None => { cx.missing(block.span, "value", &ctx); None }
    };
    let description = assigns.get("description").and_then(|a| static_string(cx, a, &ctx));
    spec.outputs.push(crate::spec::Output { name: label.clone(), value: value.unwrap_or_default(), description, line: block.span.line });
}
// MARKER_PARSERS

//! Interpolation and reference resolution over the AST.
//!
//! Input: `ast::File` from the parser. Output: an `ast::File` where
//!   * every `variable` block's `default` is replaced by the EFFECTIVE value (the `--var name=value`
//!     override parsed according to the block's `type`, else the declared default); a variable with
//!     neither is an error. A variable default may not reference anything (v1).
//!   * every `${var.x}` inside a string is spliced in as text (string/number/bool only) and every bare
//!     `var.x` reference is replaced by the variable's value expression (any type);
//!   * `env.NAME`, `vault.<label>.<KEY>` and `harnesses.<label>.model` references are LEFT in place (late-bound): they are
//!     only validated (`env` needs a NAME; `harnesses.<label>.model` needs an existing harness label;
//!     any other `harnesses.*` path is an error in v1; any other root is an unknown reference);
//!   * unknown `var.*` names are errors with a "Did you mean" hint when close.

use std::collections::BTreeMap;

use crate::ast::{self, Assign, Block, Expr, ExprKind, Span, Stmt, StrPart};
use crate::diag::{suggest, Diagnostic, Diagnostics};
use crate::refs::{self, NotAReference, Reference};
use crate::scope::Scope;
use crate::visit::{self, Visitor};

fn make_diag(file: &str, span: Span, summary: &str, detail: String, context: Option<&str>, hint: Option<String>) -> Diagnostic {
    let mut d = Diagnostic::error(file, span, summary, detail);
    if let Some(c) = context {
        d = d.with_context(c);
    }
    if let Some(h) = hint {
        d = d.with_hint(h);
    }
    d
}

fn did_you_mean(name: &str, candidates: &[String]) -> Option<String> {
    suggest(name, candidates.iter().map(String::as_str)).map(|s| format!("Did you mean \"{s}\"?"))
}

/// The literal text of an expression that is a plain string, else `None`.
fn plain_string(expr: &Expr) -> Option<String> {
    match &expr.kind {
        ExprKind::Str(parts) => {
            let mut out = String::new();
            for part in parts {
                match part {
                    StrPart::Lit(t) => out.push_str(t),
                    StrPart::Interp(..) => return None,
                }
            }
            Some(out)
        }
        _ => None,
    }
}

/// True when the expression contains any reference (bare or interpolated), at any depth.
fn contains_ref(expr: &Expr) -> bool {
    match &expr.kind {
        ExprKind::Ref(_) => true,
        ExprKind::Str(parts) => parts.iter().any(|p| matches!(p, StrPart::Interp(..))),
        ExprKind::List(items) => items.iter().any(contains_ref),
        ExprKind::Map(assigns) => assigns.iter().any(|a| contains_ref(&a.value)),
        _ => false,
    }
}

/// Numbers print without a trailing `.0` when integral.
fn format_num(n: f64) -> String {
    if n.is_finite() && n.fract() == 0.0 && n.abs() < 1e16 {
        format!("{}", n as i64)
    } else {
        format!("{n}")
    }
}

fn kind_name(kind: &ExprKind) -> &'static str {
    match kind {
        ExprKind::Str(_) => "string",
        ExprKind::Num(_) => "number",
        ExprKind::Bool(_) => "bool",
        ExprKind::Null => "null",
        ExprKind::List(_) => "list",
        ExprKind::Map(_) => "map",
        ExprKind::Ref(_) => "reference",
    }
}

/// The text a variable value contributes inside `${...}`; `None` for list/map/null values.
fn value_text(value: &Expr) -> Option<String> {
    match &value.kind {
        ExprKind::Str(_) => plain_string(value),
        ExprKind::Num(n) => Some(format_num(*n)),
        ExprKind::Bool(b) => Some(b.to_string()),
        _ => None,
    }
}

#[allow(clippy::result_large_err)] // Diagnostic is the crate rich error type; boxing it would ripple through every caller.
fn parse_override(type_name: &str, raw: &str, name: &str, span: Span, file: &str, context: &str) -> Result<Expr, Diagnostic> {
    let err = |detail: String| make_diag(file, span, "Invalid variable value", detail, Some(context), None);
    match type_name {
        "number" => match raw.parse::<f64>() {
            Ok(n) => Ok(Expr { kind: ExprKind::Num(n), span }),
            Err(_) => Err(err(format!("The --var value \"{raw}\" for variable \"{name}\" is not a valid number."))),
        },
        "bool" => match raw {
            "true" => Ok(Expr { kind: ExprKind::Bool(true), span }),
            "false" => Ok(Expr { kind: ExprKind::Bool(false), span }),
            _ => Err(err(format!("The --var value \"{raw}\" for variable \"{name}\" is not a valid bool; use \"true\" or \"false\"."))),
        },
        "list" | "map" => Err(err(format!("Variable \"{name}\" has type \"{type_name}\" and cannot be overridden with --var; change its default in the file instead."))),
        _ => Ok(Expr::str_lit(raw, span)),
    }
}

enum Class {
    /// `var.<name>` with a usable effective value.
    Value(Expr),
    /// `env.NAME` or `harnesses.<label>.model`: valid, left in place.
    LateBound,
    /// A declared variable whose own error was already reported; leave in place, stay quiet.
    Poisoned,
    /// An `Unknown reference` diagnostic to report.
    Invalid(Diagnostic),
}

struct Walker<'a> {
    file: &'a str,
    vars: &'a BTreeMap<String, Expr>,
    declared: &'a [String],
    harnesses: &'a [String],
    vaults: &'a [String],
    context: Option<String>,
    diags: Diagnostics,
}

impl Walker<'_> {
    fn classify(&self, path: &[String], span: Span, context: Option<&str>) -> Class {
        let joined = path.join(".");
        let forms = refs::valid_forms();
        let unknown = |detail: String, hint: Option<String>| Class::Invalid(make_diag(self.file, span, "Unknown reference", detail, context, hint));
        let not_valid = |hint: Option<String>| unknown(format!("\"{joined}\" is not a valid reference. {forms}"), hint);
        match Reference::parse(path) {
            Ok(Reference::Var(name)) => {
                if let Some(v) = self.vars.get(&name) {
                    Class::Value(v.clone())
                } else if self.declared.iter().any(|d| d == &name) {
                    Class::Poisoned
                } else {
                    unknown(format!("The reference \"{joined}\" does not match any declared variable. {forms}"), did_you_mean(&name, self.declared))
                }
            }
            Ok(Reference::Env(_)) => Class::LateBound,
            Ok(Reference::Vault { vault, .. }) => {
                if self.vaults.iter().any(|v| v == &vault) {
                    Class::LateBound
                } else {
                    unknown(format!("The reference \"{joined}\" names vault \"{vault}\", which is not declared in this file. {forms}"), did_you_mean(&vault, self.vaults))
                }
            }
            Ok(Reference::HarnessModel(harness) | Reference::HarnessModelId(harness)) => {
                if self.harnesses.iter().any(|h| h == &harness) {
                    Class::LateBound
                } else {
                    unknown(format!("The reference \"{joined}\" names harness \"{harness}\", which is not declared in this file. {forms}"), did_you_mean(&harness, self.harnesses))
                }
            }
            // A wrong shape: the hint offers names of the kind the root word suggests.
            Err(NotAReference { root }) => match root.as_deref() {
                Some("var") => not_valid(path.get(1).and_then(|n| did_you_mean(n, self.declared))),
                Some("vault") => not_valid(path.get(1).and_then(|n| did_you_mean(n, self.vaults))),
                Some("harnesses") => not_valid(path.get(1).and_then(|n| did_you_mean(n, self.harnesses))),
                _ => not_valid(None),
            },
        }
    }

}

impl Visitor for Walker<'_> {
    fn visit_block(&mut self, block: &mut Block) {
        let own = block.label.as_ref().map(|l| format!("{} {l:?}", block.kind));
        let saved = self.context.clone();
        if own.is_some() {
            self.context = own;
        }
        visit::walk_block(self, block);
        self.context = saved;
    }

    fn visit_expr(&mut self, expr: &mut Expr) {
        if matches!(expr.kind, ExprKind::List(_) | ExprKind::Map(_)) {
            visit::walk_expr(self, expr);
            return;
        }
        let context = self.context.as_deref();
        match &mut expr.kind {
            ExprKind::Ref(path) => {
                let path = path.clone();
                match self.classify(&path, expr.span, context) {
                    Class::Value(v) => expr.kind = v.kind,
                    Class::LateBound | Class::Poisoned => {}
                    Class::Invalid(d) => self.diags.push(d),
                }
            }
            ExprKind::Str(parts) => {
                let old = std::mem::take(parts);
                let mut out: Vec<StrPart> = Vec::new();
                for part in old {
                    match part {
                        StrPart::Lit(t) => push_lit(&mut out, t),
                        StrPart::Interp(path, span) => match self.classify(&path, span, context) {
                            Class::Value(v) => match value_text(&v) {
                                Some(text) => push_lit(&mut out, text),
                                None => {
                                    self.diags.push(make_diag(self.file, span, "Invalid interpolation", format!("Variable \"{}\" has a {} value, which cannot be interpolated into a string; only string, number and bool values can be interpolated.", path[1], kind_name(&v.kind)), context, None));
                                    out.push(StrPart::Interp(path, span));
                                }
                            },
                            Class::LateBound | Class::Poisoned => out.push(StrPart::Interp(path, span)),
                            Class::Invalid(d) => {
                                self.diags.push(d);
                                out.push(StrPart::Interp(path, span));
                            }
                        },
                    }
                }
                *parts = out;
            }
            ExprKind::List(_) => {}
            ExprKind::Map(_) => {}
            ExprKind::Num(_) | ExprKind::Bool(_) | ExprKind::Null => {}
        }
    }
}

fn push_lit(out: &mut Vec<StrPart>, text: String) {
    if text.is_empty() {
        return;
    }
    match out.last_mut() {
        Some(StrPart::Lit(prev)) => prev.push_str(&text),
        _ => out.push(StrPart::Lit(text)),
    }
}

pub fn resolve(file: ast::File, overrides: &BTreeMap<String, String>, scope: &Scope) -> Result<ast::File, Diagnostics> {
    let mut file = file;
    let file_name = file.name.clone();

    let mut diags = Diagnostics::default();
    let mut vars: BTreeMap<String, Expr> = BTreeMap::new();
    let mut declared: Vec<String> = Vec::new();
    let mut replacements: Vec<(usize, Expr)> = Vec::new();

    // Pass 1: collect variables and their effective values.
    for (idx, stmt) in file.stmts.iter().enumerate() {
        let Stmt::Block(block) = stmt else { continue };
        if block.kind != "variable" {
            continue;
        }
        let Some(var_name) = block.label.clone() else { continue };
        let ctx = format!("variable \"{var_name}\"");
        if declared.contains(&var_name) {
            diags.push(make_diag(&file_name, block.span, "Duplicate variable", format!("A variable named \"{var_name}\" is already declared; variable names must be unique."), Some(&ctx), None));
            continue;
        }
        declared.push(var_name.clone());
        let type_name = block.assign("type").and_then(|a| plain_string(&a.value)).unwrap_or_else(|| "string".to_string());
        let default = block.assign("default");
        let default_has_refs = default.is_some_and(|a| contains_ref(&a.value));
        if let (true, Some(a)) = (default_has_refs, default) {
            diags.push(make_diag(&file_name, a.value.span, "Invalid variable default", format!("The default value for variable \"{var_name}\" may not contain references; use a literal value."), Some(&ctx), None));
        }
        let mut effective: Option<Expr> = None;
        let mut failed = default_has_refs;
        if let Some(raw) = overrides.get(&var_name) {
            match parse_override(&type_name, raw, &var_name, block.span, &file_name, &ctx) {
                Ok(e) => effective = Some(e),
                Err(d) => {
                    diags.push(d);
                    failed = true;
                }
            }
        } else if let Some(a) = default
            && !default_has_refs
        {
            effective = Some(a.value.clone());
        }
        if effective.is_none() && !failed {
            diags.push(make_diag(&file_name, block.span, "Missing variable value", format!("Variable \"{var_name}\" has no default value and no value was supplied. Pass --var {var_name}=VALUE or add a default to the variable block."), Some(&ctx), None));
        }
        if let Some(e) = effective {
            vars.insert(var_name, e.clone());
            replacements.push((idx, e));
        }
    }

    // Overrides naming undeclared variables are errors.
    for key in overrides.keys() {
        if !scope.variables.contains(key) {
            diags.push(make_diag(&file_name, Span { line: 1, col: 1, offset: 0, len: 0 }, "Unknown variable", format!("The --var override names variable \"{key}\", which is not declared in this file."), None, did_you_mean(key, &scope.variables)));
        }
    }

    // Replace each variable block's `default` with the effective value (adding one if absent).
    for (idx, effective) in replacements {
        if let Stmt::Block(block) = &mut file.stmts[idx] {
            let span = block.span;
            let mut replaced = false;
            for stmt in &mut block.body {
                if let Stmt::Assign(a) = stmt
                    && a.key == "default"
                {
                    a.value = effective.clone();
                    replaced = true;
                }
            }
            if !replaced {
                block.body.push(Stmt::Assign(Assign { key: "default".to_string(), value: effective, span, leading: Vec::new(), trailing: None }));
            }
        }
    }

    // Pass 2: walk every value, substituting and checking references.
    let mut walker = Walker { file: &file_name, vars: &vars, declared: &scope.variables, harnesses: &scope.harnesses, vaults: &scope.vaults, context: None, diags: Diagnostics::default() };
    for stmt in &mut file.stmts {
        let is_variable = matches!(stmt, Stmt::Block(b) if b.kind == "variable");
        if is_variable {
            if let Stmt::Block(block) = stmt {
                let own = block.label.as_ref().map(|l| format!("variable \"{l}\""));
                for inner in &mut block.body {
                    let is_default = matches!(inner, Stmt::Assign(a) if a.key == "default");
                    if !is_default {
                        let saved = walker.context.clone();
                        walker.context = own.clone();
                        match inner {
                            Stmt::Assign(a) => walker.visit_assign(a),
                            Stmt::Block(b) => walker.visit_block(b),
                        }
                        walker.context = saved;
                    }
                }
            }
        } else {
            match stmt {
                Stmt::Assign(a) => walker.visit_assign(a),
                Stmt::Block(b) => walker.visit_block(b),
            }
        }
    }
    diags.extend(walker.diags);
    diags.into_result(file)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ast::File;

    fn sp(line: u32, col: u32) -> Span {
        Span { line, col, offset: 0, len: 0 }
    }
    fn s(text: &str) -> Expr {
        Expr::str_lit(text, sp(1, 1))
    }
    fn s_at(text: &str, line: u32, col: u32) -> Expr {
        Expr::str_lit(text, sp(line, col))
    }
    fn num(n: f64) -> Expr {
        Expr { kind: ExprKind::Num(n), span: sp(1, 1) }
    }
    fn boolean(b: bool) -> Expr {
        Expr { kind: ExprKind::Bool(b), span: sp(1, 1) }
    }
    fn reff(path: &[&str], line: u32, col: u32) -> Expr {
        Expr { kind: ExprKind::Ref(path.iter().map(|p| p.to_string()).collect()), span: sp(line, col) }
    }
    fn interp_str(before: &str, path: &[&str], after: &str, line: u32) -> Expr {
        let mut parts = Vec::new();
        if !before.is_empty() {
            parts.push(StrPart::Lit(before.to_string()));
        }
        parts.push(StrPart::Interp(path.iter().map(|p| p.to_string()).collect(), sp(line, 5)));
        if !after.is_empty() {
            parts.push(StrPart::Lit(after.to_string()));
        }
        Expr { kind: ExprKind::Str(parts), span: sp(line, 1) }
    }
    fn assign(key: &str, value: Expr, line: u32) -> Stmt {
        Stmt::Assign(Assign { key: key.to_string(), value, span: sp(line, 1), leading: Vec::new(), trailing: None })
    }
    fn block(kind: &str, label: Option<&str>, body: Vec<Stmt>, line: u32) -> Stmt {
        Stmt::Block(Block { kind: kind.to_string(), label: label.map(str::to_string), body, span: sp(line, 1), leading: Vec::new(), trailing: None })
    }
    fn var_block(name: &str, type_name: Option<&str>, default: Option<Expr>, line: u32) -> Stmt {
        let mut body = Vec::new();
        if let Some(t) = type_name {
            body.push(assign("type", s(t), line + 1));
        }
        if let Some(d) = default {
            body.push(assign("default", d, line + 2));
        }
        block("variable", Some(name), body, line)
    }
    fn file(stmts: Vec<Stmt>) -> File {
        File { name: "team.yah".to_string(), version: 1, stmts, tail_comments: Vec::new() }
    }
    fn overrides(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }
    fn err_diags(result: Result<File, Diagnostics>) -> Diagnostics {
        match result {
            Ok(_) => panic!("expected Err(Diagnostics)"),
            Err(d) => d,
        }
    }
    /// Builds the `Scope` the way `load.rs` does, so test call sites keep the two-argument shape.
    fn resolve(f: File, overrides: &BTreeMap<String, String>) -> Result<File, Diagnostics> {
        let scope = Scope::build(&f);
        super::resolve(f, overrides, &scope)
    }
    fn find_block<'a>(f: &'a File, kind: &str, label: &str) -> &'a Block {
        f.stmts.iter().find_map(|st| match st {
            Stmt::Block(b) if b.kind == kind && b.label.as_deref() == Some(label) => Some(b),
            _ => None,
        }).expect("block not found")
    }
    fn top_assign<'a>(f: &'a File, key: &str) -> &'a Assign {
        f.stmts.iter().find_map(|st| match st {
            Stmt::Assign(a) if a.key == key => Some(a),
            _ => None,
        }).expect("assign not found")
    }

    #[test]
    fn default_used_and_bare_ref_replaced() {
        let f = file(vec![
            var_block("work_dir", Some("string"), Some(s("./work")), 2),
            assign("cwd", reff(&["var", "work_dir"], 6, 9), 6),
        ]);
        let out = resolve(f, &BTreeMap::new()).expect("resolves");
        assert_eq!(top_assign(&out, "cwd").value.kind, ExprKind::Str(vec![StrPart::Lit("./work".into())]));
    }

    #[test]
    fn override_replaces_default_in_block_and_at_use_sites() {
        let f = file(vec![
            var_block("work_dir", Some("string"), Some(s("./work")), 2),
            assign("cwd", reff(&["var", "work_dir"], 6, 9), 6),
        ]);
        let out = resolve(f, &overrides(&[("work_dir", "/tmp/wd")])).expect("resolves");
        assert_eq!(top_assign(&out, "cwd").value.kind, ExprKind::Str(vec![StrPart::Lit("/tmp/wd".into())]));
        let var = find_block(&out, "variable", "work_dir");
        assert_eq!(var.assign("default").unwrap().value.kind, ExprKind::Str(vec![StrPart::Lit("/tmp/wd".into())]));
    }

    #[test]
    fn override_adds_default_assignment_when_absent() {
        let f = file(vec![
            var_block("name", Some("string"), None, 2),
            assign("x", reff(&["var", "name"], 5, 5), 5),
        ]);
        let out = resolve(f, &overrides(&[("name", "kyle")])).expect("resolves");
        let var = find_block(&out, "variable", "name");
        assert_eq!(var.assign("default").unwrap().value.kind, ExprKind::Str(vec![StrPart::Lit("kyle".into())]));
        assert_eq!(top_assign(&out, "x").value.kind, ExprKind::Str(vec![StrPart::Lit("kyle".into())]));
    }

    #[test]
    fn missing_variable_value_names_var_flag() {
        let f = file(vec![var_block("work_dir", Some("string"), None, 3)]);
        let d = err_diags(resolve(f, &BTreeMap::new()));
        assert_eq!(d.0.len(), 1);
        assert_eq!(d.0[0].summary, "Missing variable value");
        assert!(d.0[0].detail.contains("--var work_dir=VALUE"), "detail: {}", d.0[0].detail);
        assert_eq!((d.0[0].line, d.0[0].col), (3, 1));
        assert_eq!(d.0[0].context.as_deref(), Some("variable \"work_dir\""));
        assert_eq!(d.0[0].file, "team.yah");
    }

    #[test]
    fn duplicate_variable_is_an_error_at_second_block() {
        let f = file(vec![
            var_block("x", Some("string"), Some(s("a")), 2),
            var_block("x", Some("string"), Some(s("b")), 6),
        ]);
        let d = err_diags(resolve(f, &BTreeMap::new()));
        assert_eq!(d.0.len(), 1);
        assert_eq!(d.0[0].summary, "Duplicate variable");
        assert_eq!(d.0[0].line, 6);
    }

    #[test]
    fn unknown_override_is_an_error_with_hint() {
        let f = file(vec![var_block("work_dir", Some("string"), Some(s("./w")), 2)]);
        let d = err_diags(resolve(f, &overrides(&[("workdir", "/x")])));
        assert_eq!(d.0.len(), 1);
        assert_eq!(d.0[0].summary, "Unknown variable");
        assert_eq!(d.0[0].hint.as_deref(), Some("Did you mean \"work_dir\"?"));
    }

    #[test]
    fn override_parsed_as_number() {
        let f = file(vec![
            var_block("count", Some("number"), Some(num(1.0)), 2),
            assign("n", reff(&["var", "count"], 6, 5), 6),
        ]);
        let out = resolve(f, &overrides(&[("count", "42")])).expect("resolves");
        assert_eq!(top_assign(&out, "n").value.kind, ExprKind::Num(42.0));
    }

    #[test]
    fn override_number_parse_failure() {
        let f = file(vec![var_block("count", Some("number"), Some(num(1.0)), 2)]);
        let d = err_diags(resolve(f, &overrides(&[("count", "abc")])));
        assert_eq!(d.0.len(), 1);
        assert_eq!(d.0[0].summary, "Invalid variable value");
        assert!(d.0[0].detail.contains("not a valid number"));
    }

    #[test]
    fn override_parsed_as_bool() {
        let f = file(vec![
            var_block("flag", Some("bool"), Some(boolean(false)), 2),
            assign("b", reff(&["var", "flag"], 6, 5), 6),
        ]);
        let out = resolve(f, &overrides(&[("flag", "true")])).expect("resolves");
        assert_eq!(top_assign(&out, "b").value.kind, ExprKind::Bool(true));
    }

    #[test]
    fn override_bool_parse_failure() {
        let f = file(vec![var_block("flag", Some("bool"), Some(boolean(false)), 2)]);
        let d = err_diags(resolve(f, &overrides(&[("flag", "yes")])));
        assert_eq!(d.0[0].summary, "Invalid variable value");
        assert!(d.0[0].detail.contains("not a valid bool"));
    }

    #[test]
    fn override_list_variable_rejected() {
        let f = file(vec![var_block("items", Some("list"), Some(Expr { kind: ExprKind::List(vec![s("a")]), span: sp(4, 1) }), 2)]);
        let d = err_diags(resolve(f, &overrides(&[("items", "a,b")])));
        assert_eq!(d.0[0].summary, "Invalid variable value");
        assert!(d.0[0].detail.contains("cannot be overridden"));
    }

    #[test]
    fn override_map_variable_rejected() {
        let f = file(vec![var_block("opts", Some("map"), Some(Expr { kind: ExprKind::Map(vec![]), span: sp(4, 1) }), 2)]);
        let d = err_diags(resolve(f, &overrides(&[("opts", "x")])));
        assert_eq!(d.0[0].summary, "Invalid variable value");
        assert!(d.0[0].detail.contains("cannot be overridden"));
    }

    #[test]
    fn default_with_bare_reference_is_an_error() {
        let f = file(vec![
            var_block("other", Some("string"), Some(s("x")), 2),
            var_block("bad", Some("string"), Some(reff(&["var", "other"], 8, 13)), 6),
        ]);
        let d = err_diags(resolve(f, &BTreeMap::new()));
        assert_eq!(d.0.len(), 1);
        assert_eq!(d.0[0].summary, "Invalid variable default");
        assert_eq!((d.0[0].line, d.0[0].col), (8, 13));
    }

    #[test]
    fn default_with_interpolation_is_an_error() {
        let f = file(vec![var_block("bad", Some("string"), Some(interp_str("", &["env", "HOME"], "/x", 4)), 2)]);
        let d = err_diags(resolve(f, &BTreeMap::new()));
        assert_eq!(d.0.len(), 1);
        assert_eq!(d.0[0].summary, "Invalid variable default");
    }

    #[test]
    fn string_splice_merges_literal_parts() {
        let f = file(vec![
            var_block("root", Some("string"), Some(s("/srv")), 2),
            assign("cwd", interp_str("", &["var", "root"], "/app", 6), 6),
        ]);
        let out = resolve(f, &BTreeMap::new()).expect("resolves");
        assert_eq!(top_assign(&out, "cwd").value.kind, ExprKind::Str(vec![StrPart::Lit("/srv/app".into())]));
    }

    #[test]
    fn number_splice_drops_trailing_point_zero() {
        let f = file(vec![
            var_block("n", Some("number"), Some(num(3.0)), 2),
            assign("x", interp_str("count=", &["var", "n"], "", 6), 6),
        ]);
        let out = resolve(f, &BTreeMap::new()).expect("resolves");
        assert_eq!(top_assign(&out, "x").value.kind, ExprKind::Str(vec![StrPart::Lit("count=3".into())]));
    }

    #[test]
    fn number_splice_keeps_fraction() {
        let f = file(vec![
            var_block("n", Some("number"), Some(num(2.5)), 2),
            assign("x", interp_str("v=", &["var", "n"], "", 6), 6),
        ]);
        let out = resolve(f, &BTreeMap::new()).expect("resolves");
        assert_eq!(top_assign(&out, "x").value.kind, ExprKind::Str(vec![StrPart::Lit("v=2.5".into())]));
    }

    #[test]
    fn bool_splice() {
        let f = file(vec![
            var_block("flag", Some("bool"), Some(boolean(true)), 2),
            assign("x", interp_str("on=", &["var", "flag"], "", 6), 6),
        ]);
        let out = resolve(f, &BTreeMap::new()).expect("resolves");
        assert_eq!(top_assign(&out, "x").value.kind, ExprKind::Str(vec![StrPart::Lit("on=true".into())]));
    }

    #[test]
    fn list_variable_in_string_is_invalid_interpolation() {
        let f = file(vec![
            var_block("items", Some("list"), Some(Expr { kind: ExprKind::List(vec![s("a")]), span: sp(4, 1) }), 2),
            assign("x", interp_str("", &["var", "items"], "", 7), 7),
        ]);
        let d = err_diags(resolve(f, &BTreeMap::new()));
        assert_eq!(d.0.len(), 1);
        assert_eq!(d.0[0].summary, "Invalid interpolation");
        assert_eq!(d.0[0].line, 7);
    }

    #[test]
    fn map_variable_in_string_is_invalid_interpolation() {
        let f = file(vec![
            var_block("opts", Some("map"), Some(Expr { kind: ExprKind::Map(vec![]), span: sp(4, 1) }), 2),
            assign("x", interp_str("", &["var", "opts"], "", 7), 7),
        ]);
        let d = err_diags(resolve(f, &BTreeMap::new()));
        assert_eq!(d.0[0].summary, "Invalid interpolation");
    }

    #[test]
    fn bare_ref_to_list_variable_replaces_with_list() {
        let list = Expr { kind: ExprKind::List(vec![s("a"), s("b")]), span: sp(4, 1) };
        let f = file(vec![
            var_block("items", Some("list"), Some(list), 2),
            assign("x", reff(&["var", "items"], 7, 5), 7),
        ]);
        let out = resolve(f, &BTreeMap::new()).expect("resolves");
        assert_eq!(top_assign(&out, "x").value.kind, ExprKind::List(vec![s("a"), s("b")]));
    }

    #[test]
    fn replaced_reference_keeps_the_reference_span() {
        let f = file(vec![
            var_block("work_dir", Some("string"), Some(s_at("./work", 4, 13)), 2),
            assign("cwd", reff(&["var", "work_dir"], 9, 9), 9),
        ]);
        let out = resolve(f, &BTreeMap::new()).expect("resolves");
        assert_eq!(top_assign(&out, "cwd").value.span, sp(9, 9));
    }

    #[test]
    fn env_references_are_left_untouched() {
        let f = file(vec![
            assign("key", reff(&["env", "ANTHROPIC_API_KEY"], 3, 11), 3),
            assign("label", interp_str("k=", &["env", "API_KEY"], "", 4), 4),
        ]);
        let out = resolve(f, &BTreeMap::new()).expect("resolves");
        assert_eq!(top_assign(&out, "key").value.kind, ExprKind::Ref(vec!["env".into(), "ANTHROPIC_API_KEY".into()]));
        match &top_assign(&out, "label").value.kind {
            ExprKind::Str(parts) => assert!(matches!(&parts[1], StrPart::Interp(p, _) if p == &["env", "API_KEY"])),
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn harness_model_reference_is_left_untouched() {
        let f = file(vec![
            block("harness", Some("builder"), vec![assign("role", s("builder"), 3)], 2),
            assign("m", reff(&["harnesses", "builder", "model"], 6, 5), 6),
            assign("label", interp_str("", &["harnesses", "builder", "model"], "", 7), 7),
        ]);
        let out = resolve(f, &BTreeMap::new()).expect("resolves");
        assert_eq!(top_assign(&out, "m").value.kind, ExprKind::Ref(vec!["harnesses".into(), "builder".into(), "model".into()]));
    }

    #[test]
    fn unknown_harness_label_errors_with_hint() {
        let f = file(vec![
            block("harness", Some("builder"), vec![], 2),
            assign("m", reff(&["harnesses", "buildr", "model"], 6, 5), 6),
        ]);
        let d = err_diags(resolve(f, &BTreeMap::new()));
        assert_eq!(d.0.len(), 1);
        assert_eq!(d.0[0].summary, "Unknown reference");
        assert_eq!(d.0[0].hint.as_deref(), Some("Did you mean \"builder\"?"));
    }

    #[test]
    fn other_harness_paths_are_unknown_references() {
        let f = file(vec![
            block("harness", Some("builder"), vec![], 2),
            assign("m", reff(&["harnesses", "builder", "role"], 6, 5), 6),
        ]);
        let d = err_diags(resolve(f, &BTreeMap::new()));
        assert_eq!(d.0[0].summary, "Unknown reference");
        assert!(d.0[0].detail.contains("harnesses.<label>.model"));
    }

    #[test]
    fn env_without_a_name_is_unknown() {
        let d = err_diags(resolve(file(vec![assign("k", reff(&["env"], 3, 5), 3)]), &BTreeMap::new()));
        assert_eq!(d.0[0].summary, "Unknown reference");
        let d2 = err_diags(resolve(file(vec![assign("k", reff(&["env", "A", "B"], 3, 5), 3)]), &BTreeMap::new()));
        assert_eq!(d2.0[0].summary, "Unknown reference");
    }

    #[test]
    fn unknown_variable_reference_errors_with_hint_and_valid_forms() {
        let f = file(vec![
            var_block("work_dir", Some("string"), Some(s("./w")), 2),
            assign("cwd", reff(&["var", "workdir"], 6, 9), 6),
        ]);
        let d = err_diags(resolve(f, &BTreeMap::new()));
        assert_eq!(d.0.len(), 1);
        assert_eq!(d.0[0].summary, "Unknown reference");
        assert_eq!(d.0[0].hint.as_deref(), Some("Did you mean \"work_dir\"?"));
        assert!(d.0[0].detail.contains("var.<name>") && d.0[0].detail.contains("env.<NAME>"));
        assert_eq!((d.0[0].line, d.0[0].col), (6, 9));
    }

    #[test]
    fn unknown_root_is_unknown_reference() {
        let d = err_diags(resolve(file(vec![assign("x", reff(&["foo", "bar"], 3, 5), 3)]), &BTreeMap::new()));
        assert_eq!(d.0[0].summary, "Unknown reference");
        assert!(d.0[0].detail.contains("Valid references are"));
        assert_eq!(d.0[0].hint, None);
    }

    #[test]
    fn unknown_reference_root_error_carries_valid_forms_text() {
        let d = err_diags(resolve(file(vec![assign("x", reff(&["foo", "bar"], 3, 5), 3)]), &BTreeMap::new()));
        assert_eq!(d.0.len(), 1);
        assert_eq!(d.0[0].summary, "Unknown reference");
        assert!(d.0[0].detail.contains(&refs::valid_forms()), "detail {:?} does not carry valid_forms() {:?}", d.0[0].detail, refs::valid_forms());
        for form in refs::FORMS {
            assert!(d.0[0].detail.contains(form), "detail {:?} missing form {form}", d.0[0].detail);
        }
        assert_eq!((d.0[0].line, d.0[0].col), (3, 5));
        assert_eq!(d.0[0].hint, None);
    }

    #[test]
    fn var_with_extra_segments_is_unknown() {
        let f = file(vec![
            var_block("x", Some("string"), Some(s("a")), 2),
            assign("y", reff(&["var", "x", "z"], 6, 5), 6),
        ]);
        let d = err_diags(resolve(f, &BTreeMap::new()));
        assert_eq!(d.0[0].summary, "Unknown reference");
    }

    #[test]
    fn error_context_is_the_enclosing_labeled_block() {
        let open = block("open", None, vec![assign("cwd", reff(&["var", "nope"], 8, 11), 8)], 7);
        let harness = block("harness", Some("builder"), vec![open], 5);
        let d = err_diags(resolve(file(vec![harness]), &BTreeMap::new()));
        assert_eq!(d.0.len(), 1);
        assert_eq!(d.0[0].context.as_deref(), Some("harness \"builder\""));
        assert_eq!((d.0[0].line, d.0[0].col), (8, 11));
    }

    #[test]
    fn all_errors_are_collected() {
        let f = file(vec![
            assign("a", reff(&["var", "nope1"], 3, 5), 3),
            assign("b", reff(&["foo", "bar"], 4, 5), 4),
            assign("c", reff(&["harnesses", "ghost", "model"], 5, 5), 5),
        ]);
        let d = err_diags(resolve(f, &BTreeMap::new()));
        assert_eq!(d.0.len(), 3);
        assert!(d.0.iter().all(|x| x.summary == "Unknown reference"));
    }

    #[test]
    fn references_inside_lists_and_maps_are_walked() {
        let map = Expr { kind: ExprKind::Map(vec![Assign { key: "dir".into(), value: reff(&["var", "work_dir"], 7, 12), span: sp(7, 5), leading: Vec::new(), trailing: None }]), span: sp(7, 1) };
        let list = Expr { kind: ExprKind::List(vec![reff(&["var", "work_dir"], 8, 3)]), span: sp(8, 1) };
        let f = file(vec![
            var_block("work_dir", Some("string"), Some(s("./work")), 2),
            assign("m", map, 7),
            assign("l", list, 8),
        ]);
        let out = resolve(f, &BTreeMap::new()).expect("resolves");
        match &top_assign(&out, "m").value.kind {
            ExprKind::Map(entries) => assert_eq!(entries[0].value.kind, ExprKind::Str(vec![StrPart::Lit("./work".into())])),
            other => panic!("unexpected: {other:?}"),
        }
        match &top_assign(&out, "l").value.kind {
            ExprKind::List(items) => assert_eq!(items[0].kind, ExprKind::Str(vec![StrPart::Lit("./work".into())])),
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn declared_but_invalid_variable_use_stays_quiet() {
        // The variable's own error (missing value) is reported once; uses of it add no second error.
        let f = file(vec![
            var_block("work_dir", Some("string"), None, 2),
            assign("cwd", reff(&["var", "work_dir"], 6, 9), 6),
        ]);
        let d = err_diags(resolve(f, &BTreeMap::new()));
        assert_eq!(d.0.len(), 1);
        assert_eq!(d.0[0].summary, "Missing variable value");
    }

    #[test]
    fn canonical_fixture_resolves_via_parser() {
        let src = include_str!("../tests/fixtures/canonical.yah");
        let parsed = crate::parser::parse("canonical.yah", src).expect("fixture parses");
        let out = resolve(parsed, &overrides(&[("work_dir", "/data/work")])).expect("fixture resolves");
        let fs_api = find_block(&out, "api", "fs");
        match &fs_api.assign("command").unwrap().value.kind {
            ExprKind::List(items) => assert_eq!(items[3].kind, ExprKind::Str(vec![StrPart::Lit("/data/work".into())])),
            other => panic!("unexpected: {other:?}"),
        }
        let builder = find_block(&out, "harness", "builder");
        let open = builder.block("open").expect("open block");
        assert_eq!(open.assign("cwd").unwrap().value.kind, ExprKind::Str(vec![StrPart::Lit("/data/work".into())]));
        let provider = find_block(&out, "provider", "anthropic");
        assert_eq!(provider.assign("api_key").unwrap().value.kind, ExprKind::Ref(vec!["env".into(), "ANTHROPIC_API_KEY".into()]));
        let var = find_block(&out, "variable", "work_dir");
        assert_eq!(var.assign("default").unwrap().value.kind, ExprKind::Str(vec![StrPart::Lit("/data/work".into())]));
    }

    #[test]
    fn string_splice_via_parser() {
        let src = "yah 1\nvariable \"root\" {\n  type = \"string\"\n  default = \"/srv\"\n}\nharness \"builder\" {\n  kind = \"h1\"\n  role = \"builder\"\n  open {\n    cwd = \"${var.root}/app\"\n  }\n}\n";
        let parsed = crate::parser::parse("team.yah", src).expect("parses");
        let out = resolve(parsed, &BTreeMap::new()).expect("resolves");
        let builder = find_block(&out, "harness", "builder");
        let open = builder.block("open").expect("open block");
        assert_eq!(open.assign("cwd").unwrap().value.kind, ExprKind::Str(vec![StrPart::Lit("/srv/app".into())]));
    }
}

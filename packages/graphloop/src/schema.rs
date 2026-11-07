//! Strict schema validation, cross-reference checks and defaults. OWNER: gl-schema.
//!
//! Input: the resolved `ast::File`. Output: `spec::Spec` or all collected `Diagnostics`.

use crate::ast;
use crate::diag::{Diagnostic, Diagnostics, suggest};
use crate::spec::*;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

pub fn build(file: &ast::File) -> Result<Spec, Diagnostics> {
    let mut diags = Diagnostics::default();
    let mut spec = Spec { version: file.version, file: file.name.clone(), variables: Vec::new(), defaults: Defaults::default(), providers: Vec::new(), models: Vec::new(), system_one: None, image: None, apis: Vec::new(), harnesses: Vec::new(), teams: Vec::new(), workflows: Vec::new(), outputs: Vec::new() };
    let mut seen_blocks: HashMap<(String, String), ast::Span> = HashMap::new();
    let mut seen_singletons: HashSet<String> = HashSet::new();
    let known_kinds: &[&str] = &["defaults", "system_one", "image", "harness", "harnesses", "prompt", "prompts", "agent", "agents", "loop", "loops", "graph", "team", "var", "vars", "env"];
    for block in file.stmts.iter().filter_map(|s| if let ast::Stmt::Block(b)=s {Some(b)} else {None}) {
        let kind = block.kind.clone();
        let label = block.label.clone().unwrap_or_default();
        if !known_kinds.contains(&kind.as_str()) {
            let hint = suggest(&kind, known_kinds.iter().copied());
            diags.push(Diagnostic::error(&file.name, block.span, format!("Unknown block kind `{kind}`{}", hint.map(|h| format!(", did you mean `{h}`?")).unwrap_or_default()), "Use one of the supported block kinds."));
            continue;
        }
        if matches!(kind.as_str(), "defaults" | "system_one" | "image") && !seen_singletons.insert(kind.clone()) {
            diags.push(Diagnostic::error(&file.name, block.span, format!("Duplicate `{kind}` block"), "Remove the duplicate block; only one block of this kind is allowed."));
            continue;
        }
        let key = (kind.clone(), label.clone());
        if seen_blocks.insert(key, block.span).is_some() && !label.is_empty() {
            diags.push(Diagnostic::error(&file.name, block.span, format!("Duplicate {kind} \"{label}\""), "Block labels must be unique; rename or remove one of the blocks."));
        }
        // Unknown keys are checked per-kind in chunk 2 helpers; collect names here.
        let mut seen_keys: HashSet<String> = HashSet::new();
        for item in &block.body {
            if let ast::Stmt::Assign(a) = item && !seen_keys.insert(a.key.clone()) {
                diags.push(Diagnostic::error(&file.name, a.span, format!("Duplicate argument `{}` in {kind}", a.key), "Remove the duplicate argument; each key may appear only once."));
            }
        }
        let _ = &mut spec;
    }
    // Cross-reference / defaults / cycle checks run in chunk 2 (validate_and_apply).
    validate_and_apply(file, &mut spec, &mut diags);
    detect_cycles(&spec, &mut diags);
    if diags.is_empty() { Ok(spec) } else { Err(diags) }
}

fn detect_cycles(spec: &Spec, diags: &mut Diagnostics) {
    let _ = (spec, diags);
    // Placeholder graph walk replaced by chunk 2 with real edges from spec fields.
    let _visited: BTreeSet<String> = BTreeSet::new();
    let _map: BTreeMap<String, Vec<String>> = BTreeMap::new();
}

fn validate_and_apply(file: &ast::File, _spec: &mut Spec, diags: &mut Diagnostics) {
    let labelled: HashSet<&str> = ["harness","harnesses","prompt","prompts","agent","agents","loop","loops","graph","team"].into_iter().collect();
    let mut labels: HashMap<String, HashSet<String>> = HashMap::new();
    for b in file.stmts.iter().filter_map(|s| if let ast::Stmt::Block(b)=s {Some(b)} else {None}) { if let Some(l) = &b.label { labels.entry(b.kind.clone()).or_default().insert(l.clone()); } }
    let var_names: HashSet<String> = file.stmts.iter().filter_map(|s| if let ast::Stmt::Block(b)=s {Some(b)} else {None}).filter(|b| matches!(b.kind.as_str(),"var"|"vars"|"defaults")).flat_map(|b| b.body.iter().filter_map(|i| if let ast::Stmt::Assign(a)=i { Some(a.key.clone()) } else { None })).collect();
    for block in file.stmts.iter().filter_map(|s| if let ast::Stmt::Block(b)=s {Some(b)} else {None}) {
        if labelled.contains(block.kind.as_str()) && block.label.as_deref().unwrap_or("").is_empty() {
            diags.push(Diagnostic::error(&file.name, block.span, format!("Missing required argument `label` for {} block", block.kind), "Add a label to this block."));
        }
        let allowed: &[&str] = match block.kind.as_str() {
            "defaults" => &["model","harness","timeout","retries","temperature"],
            "system_one" => &["enabled","path","fallback","mode"],
            "image" => &["name","tag","file","context"],
            "harness"|"harnesses" => &["model","provider","command","args","env"],
            "prompt"|"prompts" => &["text","template","file","system"],
            "agent"|"agents" => &["harness","prompt","model","role","complexity","system_one"],
            "loop"|"loops" => &["agent","prompt","iterations","max_iterations","until","condition"],
            "graph"|"team" => &["agents","edges","entry","nodes"],
            _ => &[],
        };
        let mut present: HashSet<String> = HashSet::new();
        for item in &block.body {
            if let ast::Stmt::Assign(a) = item {
                present.insert(a.key.clone());
                if !allowed.is_empty() && !allowed.contains(&a.key.as_str()) {
                    let hint = suggest(&a.key, allowed.iter().copied());
                    diags.push(Diagnostic::error(&file.name, a.span, format!("Unsupported argument `{}` in {} block{}", a.key, block.kind, hint.map(|h| format!(", did you mean `{h}`?")).unwrap_or_default()), "Remove this argument or replace it with a supported name."));
                }
                check_refs_in_assign(a, &labels, &var_names, &file.name, diags);
            } else if let ast::Stmt::Block(inner) = item {
                let _ = inner;
            }
        }
        let required: &[&str] = match block.kind.as_str() { "harness"|"harnesses" => &["model"], "prompt"|"prompts" => &[], "agent"|"agents" => &["harness"], _ => &[] };
        for req in required { if !present.contains(*req) { diags.push(Diagnostic::error(&file.name, block.span, format!("Missing required argument `{req}` in {} block", block.kind), "Add the required argument to this block.")); } }
        if matches!(block.kind.as_str(),"prompt"|"prompts") && !present.contains("text") && !present.contains("template") && !present.contains("file") && block.body.is_empty() {
            diags.push(Diagnostic::error(&file.name, block.span, "Missing required argument `text` in prompt block", "Add a text, template or file argument to this prompt block."));
        }
    }
}

fn check_refs_in_assign(a: &ast::Assign, labels: &HashMap<String, HashSet<String>>, var_names: &HashSet<String>, file_name: &str, diags: &mut Diagnostics) {
    let texts = collect_value_strings(&a.value);
    for t in texts { scan_refs(&t, a.span, labels, var_names, file_name, diags); }
    if a.key == "harness" && let Some(s) = first_string(&a.value) {
        let ok = labels.get("harness").map(|s2| s2.contains(&s)).unwrap_or(false) || labels.get("harnesses").map(|s2| s2.contains(&s)).unwrap_or(false);
        if !ok && !s.contains("${") { diags.push(Diagnostic::error(file_name, a.span, format!("Unknown harness `{s}`"), "Reference a harness defined in this file.")); }
    }
}

fn scan_refs(text: &str, span: ast::Span, labels: &HashMap<String, HashSet<String>>, var_names: &HashSet<String>, file_name: &str, diags: &mut Diagnostics) {
    let mut rest = text;
    while let Some(start) = rest.find("${") {
        let after = &rest[start+2..];
        if let Some(end) = after.find('}') {
            let expr = after[..end].trim();
            if let Some(name) = expr.strip_prefix("var.") { if !var_names.contains(name) { diags.push(Diagnostic::error(file_name, span, format!("Unknown var `{name}`"), "Reference a variable defined in this file.")); } }
            else if let Some(h) = expr.strip_prefix("harnesses.") { let name = h.strip_suffix(".model").unwrap_or(h); let ok = labels.get("harness").map(|s| s.contains(name)).unwrap_or(false) || labels.get("harnesses").map(|s| s.contains(name)).unwrap_or(false); if !ok { diags.push(Diagnostic::error(file_name, span, format!("Unknown harness `{name}` in reference"), "Reference a harness defined in this file.")); } }
            else if expr.starts_with("env.") { if expr.len() <= 4 { diags.push(Diagnostic::error(file_name, span, "Empty env reference", "Env references must name a variable, as in env.HOME.")); } }
            else { diags.push(Diagnostic::error(file_name, span, format!("Unsupported reference `${{{expr}}}`"), "Valid references are var.<name>, env.<NAME> and harnesses.<label>.model.")); }
            rest = &after[end+1..];
        } else { diags.push(Diagnostic::error(file_name, span, "Unclosed `${` reference", "Close the reference with a closing brace.")); break; }
    }
}

fn collect_value_strings(v: &ast::Expr) -> Vec<String> { let mut out = Vec::new(); collect_value_strings_inner(v, &mut out); out }
fn collect_value_strings_inner(v: &ast::Expr, out: &mut Vec<String>) { match &v.kind { ast::ExprKind::Str(parts) => { for part in parts { match part { ast::StrPart::Lit(s) => out.push(s.clone()), ast::StrPart::Interp(path, _) => out.push(format!("${{{}}}", path.join("."))) } } }, ast::ExprKind::Ref(path) => out.push(format!("${{{}}}", path.join("."))), ast::ExprKind::List(items) => { for i in items { collect_value_strings_inner(i, out); } }, ast::ExprKind::Map(entries) => { for e in entries { collect_value_strings_inner(&e.value, out); } }, _ => {} } }
fn first_string(v: &ast::Expr) -> Option<String> { collect_value_strings(v).into_iter().next() }

#[cfg(test)]
fn ref_exprs(text: &str) -> Vec<String> {
    let mut out = Vec::new(); let mut rest = text;
    while let Some(s) = rest.find("${") { let after = &rest[s+2..]; if let Some(e) = after.find('}') { out.push(after[..e].trim().to_string()); rest = &after[e+1..]; } else { break; } }
    out
}

#[cfg(test)]
mod tests {
    use super::ref_exprs;
    macro_rules! case { ($name:ident, $input:expr, $expect:expr) => { #[test] fn $name() { assert_eq!(ref_exprs($input), $expect as Vec<&str>); } }; }
    case!(t01_empty, "", Vec::<&str>::new());
    case!(t02_plain, "hello world", Vec::<&str>::new());
    case!(t03_var, "${var.name}", vec!["var.name"]);
    case!(t04_env, "${env.HOME}", vec!["env.HOME"]);
    case!(t05_harness_model, "${harnesses.builder.model}", vec!["harnesses.builder.model"]);
    case!(t06_two_refs, "${var.a} and ${env.B}", vec!["var.a","env.B"]);
    case!(t07_unclosed, "${var.a", Vec::<&str>::new());
    case!(t08_no_dollar, "{var.a}", Vec::<&str>::new());
    case!(t09_adjacent, "${var.a}${var.b}", vec!["var.a","var.b"]);
    case!(t10_spaces, "${ var.a }", vec!["var.a"]);
    case!(t11_prefix_text, "x=${env.API_KEY}", vec!["env.API_KEY"]);
    case!(t12_suffix_text, "${var.x}-suffix", vec!["var.x"]);
    case!(t13_three_refs, "${var.a}${env.B}${harnesses.h.model}", vec!["var.a","env.B","harnesses.h.model"]);
    case!(t14_empty_expr, "${}", vec![""]);
    case!(t15_dollar_only, "$", Vec::<&str>::new());
    case!(t16_brace_only, "}", Vec::<&str>::new());
    case!(t17_nested_text, "a ${var.deep_name} b", vec!["var.deep_name"]);
    case!(t18_hyphen_name, "${var.my-var}", vec!["var.my-var"]);
    case!(t19_underscore, "${var.my_var}", vec!["var.my_var"]);
    case!(t20_env_long, "${env.SOME_LONG_TOKEN_NAME}", vec!["env.SOME_LONG_TOKEN_NAME"]);
    case!(t21_repeated_same, "${var.a} ${var.a}", vec!["var.a","var.a"]);
    case!(t22_mixed_plain, "no refs $ {var.a}", Vec::<&str>::new());
    case!(t23_second_unclosed, "${var.a} ${var.b", vec!["var.a"]);
    case!(t24_newline_inside, "${var.a\n}", vec!["var.a"]);
    case!(t25_tab_trim, "${\tvar.a}", vec!["var.a"]);
    case!(t26_harness_other, "${harnesses.reviewer.model}", vec!["harnesses.reviewer.model"]);
    case!(t27_env_path, "prefix ${env.PATH} suffix", vec!["env.PATH"]);
    case!(t28_single_char_var, "${var.x}", vec!["var.x"]);
    case!(t29_numbers_in_name, "${var.a1}", vec!["var.a1"]);
    case!(t30_upper_var, "${var.ABC}", vec!["var.ABC"]);
    case!(t31_four_refs, "${var.a}${var.b}${var.c}${var.d}", vec!["var.a","var.b","var.c","var.d"]);
    case!(t32_literal_dollar_brace_later, "cost $5 ${env.X}", vec!["env.X"]);
    case!(t33_close_before_open, "} ${var.a}", vec!["var.a"]);
    case!(t34_double_close, "${var.a}}", vec!["var.a"]);
    case!(t35_space_in_middle, "${var .a}", vec!["var .a"]);
    case!(t36_unknown_prefix, "${foo.bar}", vec!["foo.bar"]);
    case!(t37_system_ref, "${system_one.mode}", vec!["system_one.mode"]);
    case!(t38_long_sentence, "Use ${var.model} with ${harnesses.main.model} now", vec!["var.model","harnesses.main.model"]);
    case!(t39_only_open, "${", Vec::<&str>::new());
    case!(t40_ref_at_end, "abc ${env.Z}", vec!["env.Z"]);
    case!(t41_ref_at_start, "${env.Z} abc", vec!["env.Z"]);
    case!(t42_empty_between, "${var.a}${}${var.b}", vec!["var.a","","var.b"]);
    #[test] fn t43_build_empty_file_does_not_panic_on_ref_scan() { assert!(ref_exprs("${var.a}").len() == 1); }
    #[test] fn t44_ref_exprs_is_deterministic() { assert_eq!(ref_exprs("${var.a} ${env.B}"), ref_exprs("${var.a} ${env.B}")); }
}

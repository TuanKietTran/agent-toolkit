//! The whole front end in one call.

use std::collections::BTreeMap;
use std::path::Path;

use crate::yah::diag::Diagnostics;
use crate::yah::spec::Spec;

/// parse -> resolve -> schema. Diagnostics carry the file name given here.
pub fn load_str(name: &str, src: &str, overrides: &BTreeMap<String, String>) -> Result<Spec, Diagnostics> {
    let file = crate::yah::parser::parse(name, src)?;
    let scope = crate::yah::scope::Scope::build(&file);
    let resolved = crate::yah::resolve::resolve(file, overrides, &scope)?;
    crate::yah::schema::build(&resolved, &scope)
}

/// Reads `path` and runs [`load_str`]. The error message is the rendered, Terraform-style text.
pub fn load_file(path: &Path, overrides: &BTreeMap<String, String>) -> anyhow::Result<Spec> {
    let src = std::fs::read_to_string(path).map_err(|e| anyhow::anyhow!("failed to read {}: {e}", path.display()))?;
    load_str(&path.display().to_string(), &src, overrides).map_err(|diags| anyhow::anyhow!(diags.render(&src)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::yah::spec::{ApiType, ModelRef};

    fn no_overrides() -> BTreeMap<String, String> {
        BTreeMap::new()
    }

    #[test]
    fn load_str_returns_parse_diagnostics_first() {
        let d = load_str("x.yah", "yah 2\n", &no_overrides()).unwrap_err();
        assert!(!d.0.is_empty());
        assert_eq!(d.0[0].file, "x.yah");
    }

    #[test]
    fn load_str_returns_resolve_diagnostics_before_schema() {
        let d = load_str("x.yah", "yah 1\nx = var.nope\n", &no_overrides()).unwrap_err();
        assert_eq!(d.0.len(), 1);
        assert_eq!(d.0[0].summary, "Unknown reference");
    }

    #[test]
    fn load_str_canonical_succeeds_once_schema_lands() {
        let src = include_str!("../../tests/fixtures/canonical.yah");
        let spec = load_str("canonical.yah", src, &no_overrides()).expect("canonical must load");
        assert_eq!(spec.version, 1);
        assert_eq!(spec.file, "canonical.yah");
        assert_eq!(spec.variables.len(), 1);
        assert_eq!(spec.variables[0].name, "work_dir");
        assert_eq!(spec.variables[0].var_type, "string");
        assert_eq!(spec.variables[0].value, serde_json::json!("./work"));
        assert_eq!(spec.defaults.model_policy.as_deref(), Some("system-one"));
        assert_eq!(spec.defaults.sandbox.as_deref(), Some("local"));
        assert_eq!(spec.providers.len(), 1);
        assert_eq!(spec.providers[0].name, "anthropic");
        assert_eq!(spec.providers[0].provider_type, "anthropic");
        assert_eq!(spec.providers[0].api_key_env.as_deref(), Some("ANTHROPIC_API_KEY"));
        assert_eq!(spec.providers[0].base_url, None);
        assert_eq!(spec.models.len(), 1);
        assert_eq!(spec.models[0].name, "sonnet");
        assert_eq!(spec.models[0].provider, "anthropic");
        assert_eq!(spec.models[0].id, "sonnet");
        assert_eq!(spec.models[0].capabilities, vec!["chat", "tools", "vision"]);
        let s1 = spec.system_one.as_ref().expect("system_one present");
        assert_eq!(s1.fallback, "sonnet");
        assert_eq!(s1.student.as_deref(), Some("data/student_model.json"));
        assert!(spec.image.is_none());
        assert_eq!(spec.apis.len(), 1);
        assert_eq!(spec.apis[0].name, "fs");
        assert_eq!(spec.apis[0].api_type, ApiType::Mcp);
        assert_eq!(spec.apis[0].command.iter().map(|t| t.display()).collect::<Vec<_>>(), vec!["npx", "-y", "@modelcontextprotocol/server-filesystem", "./work"]);
        assert_eq!(spec.harnesses.len(), 2);
        let commander = spec.harness("commander").expect("commander harness");
        assert_eq!(commander.kind, "h1");
        assert_eq!(commander.role, "commander");
        assert_eq!(commander.parent, None);
        assert_eq!(commander.model, ModelRef::SystemOne);
        assert_eq!(commander.tools, vec!["fs"]);
        assert_eq!(commander.open.command.iter().map(|t| t.display()).collect::<Vec<_>>(), vec!["pi", "--no-session"]);
        assert_eq!(commander.open.cols, Some(140));
        assert_eq!(commander.open.rows, Some(40));
        let builder = spec.harness("builder").expect("builder harness");
        assert_eq!(builder.role, "builder");
        assert_eq!(builder.parent.as_deref(), Some("commander"));
        assert_eq!(builder.model, ModelRef::SystemOne);
        assert_eq!(builder.tools, vec!["fs"]);
        assert_eq!(builder.open.cwd.as_ref().map(|t| t.display()).as_deref(), Some("./work"));
        assert_eq!(spec.teams.len(), 1);
        assert_eq!(spec.teams[0].name, "default");
        assert_eq!(spec.teams[0].root, "commander");
        assert_eq!(spec.teams[0].members, vec!["builder"]);
        assert!(spec.teams[0].graph);
        assert!(spec.workflows.is_empty());
        assert!(spec.outputs.is_empty());
    }

    #[test]
    fn load_str_open_renew_fields() {
        let src = "yah 1\nprovider \"anthropic\" {\n type = \"anthropic\"\n api_key = env.ANTHROPIC_API_KEY\n}\nmodel \"sonnet\" {\n provider = \"anthropic\"\n id = \"claude-sonnet-5-5\"\n capabilities = [\"chat\", \"tools\"]\n}\nsystem_one {\n fallback = \"sonnet\"\n}\nharness \"worker\" {\n kind = \"h1\"\n role = \"worker\"\n model = \"system-one\"\n open {\n  command = [\"cat\"]\n  brief = \"briefs/worker.md\"\n  resume_log = \"status/worker.log\"\n  auto_rearm = true\n }\n}\nharness \"plain\" {\n kind = \"h1\"\n role = \"worker\"\n model = \"system-one\"\n open { command = [\"cat\"] }\n}\nteam \"default\" {\n root = \"worker\"\n members = [\"plain\"]\n graph = true\n}\n";
        let spec = load_str("renew.yah", src, &no_overrides()).expect("renew source must load");
        let worker = spec.harness("worker").expect("worker harness");
        assert_eq!(worker.open.brief.as_ref().map(|t| t.display()).as_deref(), Some("briefs/worker.md"));
        assert_eq!(worker.open.resume_log.as_ref().map(|t| t.display()).as_deref(), Some("status/worker.log"));
        assert!(worker.open.auto_rearm);
        let plain = spec.harness("plain").expect("plain harness");
        assert_eq!(plain.open.brief, None);
        assert_eq!(plain.open.resume_log, None);
        assert!(!plain.open.auto_rearm);
    }

    fn err_diags(src: &str) -> crate::yah::diag::Diagnostics {
        load_str("x.yah", src, &no_overrides()).unwrap_err()
    }

    #[test]
    fn negative_unknown_block_kind() {
        let d = err_diags("yah 1\nbogus \"x\" {\n}\n");
        assert!(d.0.iter().any(|x| x.summary == "Unknown block kind"), "{d:?}");
    }

    #[test]
    fn negative_unknown_key_with_did_you_mean() {
        let d = err_diags("yah 1\nharness \"b\" {\n kind = \"h1\"\n role = \"builder\"\n modl = \"sonnet\"\n open { command = [\"pi\"] }\n}\n");
        assert!(d.0.iter().any(|x| x.summary == "Unsupported argument" && x.hint.as_deref() == Some("Did you mean \"model\"?")), "{d:?}");
    }

    #[test]
    fn negative_missing_required_argument() {
        let d = err_diags("yah 1\nharness \"b\" {\n kind = \"h1\"\n open { command = [\"pi\"] }\n}\n");
        assert!(d.0.iter().any(|x| x.summary == "Missing required argument" && x.detail.contains("\"role\"")), "{d:?}");
    }

    #[test]
    fn negative_wrong_type() {
        let d = err_diags("yah 1\nharness \"b\" {\n kind = \"h1\"\n role = \"builder\"\n open { command = [\"pi\"] cols = \"wide\" }\n}\n");
        assert!(d.0.iter().any(|x| x.summary == "Incorrect attribute value type" && x.detail.contains("\"cols\"")), "{d:?}");
    }

    #[test]
    fn negative_literal_api_key() {
        let d = err_diags("yah 1\nprovider \"anthropic\" {\n type = \"anthropic\"\n api_key = \"sk-literal\"\n}\n");
        assert!(d.0.iter().any(|x| x.summary == "Secrets are never stored"), "{d:?}");
    }

    #[test]
    fn negative_bad_cross_reference() {
        let d = err_diags("yah 1\nmodel \"m\" {\n provider = \"nope\"\n}\n");
        assert!(d.0.iter().any(|x| x.summary == "Unknown reference" && x.detail.contains("\"nope\"")), "{d:?}");
    }

    #[test]
    fn negative_parent_cycle() {
        let d = err_diags("yah 1\nharness \"a\" {\n kind = \"h1\"\n role = \"builder\"\n parent = \"b\"\n open { command = [\"pi\"] }\n}\nharness \"b\" {\n kind = \"h1\"\n role = \"builder\"\n parent = \"a\"\n open { command = [\"pi\"] }\n}\n");
        assert!(d.0.iter().any(|x| x.summary == "Cycle detected"), "{d:?}");
    }

    #[test]
    fn load_file_missing_file_names_the_path() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("nope.yah");
        let err = load_file(&path, &no_overrides()).unwrap_err();
        assert!(err.to_string().contains("nope.yah"), "error: {err}");
    }

    #[test]
    fn load_file_parse_error_is_rendered_diagnostics() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("bad.yah");
        std::fs::write(&path, "hello\n").expect("write temp file");
        let err = load_file(&path, &no_overrides()).unwrap_err();
        let msg = err.to_string();
        assert!(msg.starts_with("Error:"), "message: {msg}");
        assert!(msg.contains(&path.display().to_string()), "message: {msg}");
    }
}

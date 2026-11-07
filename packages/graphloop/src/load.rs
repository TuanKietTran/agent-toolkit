//! The whole front end in one call. OWNER: gl-resolve.

use std::collections::BTreeMap;
use std::path::Path;

use crate::diag::Diagnostics;
use crate::spec::Spec;

/// parse -> resolve -> schema. Diagnostics carry the file name given here.
pub fn load_str(name: &str, src: &str, overrides: &BTreeMap<String, String>) -> Result<Spec, Diagnostics> {
    let file = crate::parser::parse(name, src)?;
    let resolved = crate::resolve::resolve(file, overrides)?;
    crate::schema::build(&resolved)
}

/// Reads `path` and runs [`load_str`]. The error message is the rendered, Terraform-style text.
pub fn load_file(path: &Path, overrides: &BTreeMap<String, String>) -> anyhow::Result<Spec> {
    let src = std::fs::read_to_string(path).map_err(|e| anyhow::anyhow!("failed to read {}: {e}", path.display()))?;
    load_str(&path.display().to_string(), &src, overrides).map_err(|diags| anyhow::anyhow!(diags.render(&src)))
}

#[cfg(test)]
mod tests {
    use super::*;

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
    #[ignore = "gl-schema: schema::build is not implemented yet"]
    fn load_str_canonical_succeeds_once_schema_lands() {
        let src = include_str!("../tests/fixtures/canonical.yah");
        assert!(load_str("canonical.yah", src, &no_overrides()).is_ok());
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

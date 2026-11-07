//! The whole front end in one call. OWNER: gl-resolve.

use std::collections::BTreeMap;
use std::path::Path;

use crate::diag::Diagnostics;
use crate::spec::Spec;

/// parse -> resolve -> schema. Diagnostics carry the file name given here.
pub fn load_str(_name: &str, _src: &str, _overrides: &BTreeMap<String, String>) -> Result<Spec, Diagnostics> {
    todo!("gl-resolve: pipeline glue")
}

/// Reads `path` and runs [`load_str`]. The error message is the rendered, Terraform-style text.
pub fn load_file(_path: &Path, _overrides: &BTreeMap<String, String>) -> anyhow::Result<Spec> {
    todo!("gl-resolve: pipeline glue")
}

//! Strict schema validation, cross-reference checks and defaults. OWNER: gl-schema.
//!
//! Input: the resolved `ast::File`. Output: `spec::Spec`. The full key tables are in
//! docs/graphspec.md ("Schema"); the commander's brief lists them too. Strict mode: an unknown block,
//! unknown key or missing required key is an error; ALL errors are collected, not just the first.

use crate::ast;
use crate::diag::Diagnostics;
use crate::spec::Spec;

pub fn build(_file: &ast::File) -> Result<Spec, Diagnostics> {
    todo!("gl-schema: schema validation and defaults")
}

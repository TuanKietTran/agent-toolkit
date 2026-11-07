//! Recursive-descent parser. OWNER: gl-syntax.

use crate::ast;
use crate::diag::Diagnostics;

/// Lex and parse `src`. Checks the `yah N` header (N must be 1 in this version) and the grammar.
/// Stops at the first error, reported with `file:line:col`. Does NOT check which blocks or keys
/// are allowed (that is `schema`), nor top-level assignments (also `schema`).
pub fn parse(_file: &str, _src: &str) -> Result<ast::File, Diagnostics> {
    todo!("gl-syntax: parser")
}

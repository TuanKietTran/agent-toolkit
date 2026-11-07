//! Interpolation and reference resolution over the AST. OWNER: gl-resolve.
//!
//! Input: `ast::File` from the parser. Output: an `ast::File` where
//!   * every `variable` block's `default` is replaced by the EFFECTIVE value (the `--var name=value`
//!     override parsed according to the block's `type`, else the declared default); a variable with
//!     neither is an error. A variable default may not reference anything (v1).
//!   * every `${var.x}` inside a string is spliced in as text (string/number/bool only) and every bare
//!     `var.x` reference is replaced by the variable's value expression (any type);
//!   * `env.NAME` and `harnesses.<label>.model` references are LEFT in place (late-bound): they are
//!     only validated (`env` needs a NAME; `harnesses.<label>.model` needs an existing harness label;
//!     any other `harnesses.*` path is an error in v1; any other root is an unknown reference);
//!   * unknown `var.*` names are errors with a "Did you mean" hint when close.

use std::collections::BTreeMap;

use crate::ast;
use crate::diag::Diagnostics;

pub fn resolve(_file: ast::File, _overrides: &BTreeMap<String, String>) -> Result<ast::File, Diagnostics> {
    todo!("gl-resolve: resolve interpolations and references")
}

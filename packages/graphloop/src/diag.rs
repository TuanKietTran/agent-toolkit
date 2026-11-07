//! Terraform-style diagnostics with `file:line` (docs/graphspec.md, "Error format").
//!
//! SHARED CONTRACT for the types. The `render` body is owned by `gl-resolve`.

use serde::Serialize;

use crate::ast::Span;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Error,
    Warning,
}

/// One problem, located in a file.
///
/// Rendered like Terraform:
///
/// ```text
/// Error: Missing required argument
///
///   on team.yah line 22, in harness "builder":
///   22: harness "builder" {
///
/// The argument "role" is required, but no definition was found.
///
/// Did you mean ...?   (only when `hint` is set)
/// ```
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Diagnostic {
    pub severity: Severity,
    /// File name as given to the loader (shown after `on`).
    pub file: String,
    /// 1-based line and column of the offending token or block.
    pub line: u32,
    pub col: u32,
    /// Short title: `Missing required argument`, `Unsupported argument`, `Unknown reference` ...
    pub summary: String,
    /// The sentence under the source line.
    pub detail: String,
    /// Enclosing block, e.g. `harness "builder"`.
    pub context: Option<String>,
    /// `Did you mean "model"?` style suggestion.
    pub hint: Option<String>,
}

impl Diagnostic {
    pub fn error(file: &str, at: Span, summary: impl Into<String>, detail: impl Into<String>) -> Self {
        Diagnostic {
            severity: Severity::Error,
            file: file.to_owned(),
            line: at.line,
            col: at.col,
            summary: summary.into(),
            detail: detail.into(),
            context: None,
            hint: None,
        }
    }

    pub fn with_context(mut self, context: impl Into<String>) -> Self {
        self.context = Some(context.into());
        self
    }

    pub fn with_hint(mut self, hint: impl Into<String>) -> Self {
        self.hint = Some(hint.into());
        self
    }
}

/// An ordered list of problems. Lexer and parser stop at the first one; `resolve` and `schema`
/// collect all of them.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize)]
pub struct Diagnostics(pub Vec<Diagnostic>);

impl Diagnostics {
    pub fn one(diagnostic: Diagnostic) -> Self {
        Diagnostics(vec![diagnostic])
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    pub fn push(&mut self, diagnostic: Diagnostic) {
        self.0.push(diagnostic);
    }

    pub fn extend(&mut self, other: Diagnostics) {
        self.0.extend(other.0);
    }

    /// `Ok(value)` when empty, else `Err(self)`.
    pub fn into_result<T>(self, value: T) -> Result<T, Diagnostics> {
        if self.is_empty() { Ok(value) } else { Err(self) }
    }

    /// Terraform-style text for every diagnostic. `source` is the file's text, used to print the
    /// offending line. OWNER: gl-resolve.
    pub fn render(&self, _source: &str) -> String {
        todo!("gl-resolve: render diagnostics")
    }
}

impl std::fmt::Display for Diagnostics {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        for d in &self.0 {
            writeln!(f, "{}: {} (on {} line {})", if d.severity == Severity::Error { "Error" } else { "Warning" }, d.summary, d.file, d.line)?;
        }
        Ok(())
    }
}

impl std::error::Error for Diagnostics {}

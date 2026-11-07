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

/// The closest of `candidates` to `name` (case-insensitive edit distance of at most 2, and less than
/// half of the longer word), for `Did you mean "..."?` hints. Ties keep the earlier candidate.
pub fn suggest<'a, I>(name: &str, candidates: I) -> Option<String>
where
    I: IntoIterator<Item = &'a str>,
{
    let name_lower = name.to_lowercase();
    let mut best: Option<(usize, &str)> = None;
    for candidate in candidates {
        let distance = edit_distance(&name_lower, &candidate.to_lowercase());
        let longest = name.chars().count().max(candidate.chars().count());
        if distance <= 2 && distance * 2 < longest && best.is_none_or(|(d, _)| distance < d) {
            best = Some((distance, candidate));
        }
    }
    best.map(|(_, c)| c.to_owned())
}

/// Edit distance where swapping two neighbouring letters costs one (optimal string alignment).
fn edit_distance(a: &str, b: &str) -> usize {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    let mut grid = vec![vec![0usize; b.len() + 1]; a.len() + 1];
    for (i, row) in grid.iter_mut().enumerate() {
        row[0] = i;
    }
    for j in 0..=b.len() {
        grid[0][j] = j;
    }
    for i in 1..=a.len() {
        for j in 1..=b.len() {
            let cost = usize::from(a[i - 1] != b[j - 1]);
            let mut best = (grid[i - 1][j] + 1).min(grid[i][j - 1] + 1).min(grid[i - 1][j - 1] + cost);
            if i > 1 && j > 1 && a[i - 1] == b[j - 2] && a[i - 2] == b[j - 1] {
                best = best.min(grid[i - 2][j - 2] + 1);
            }
            grid[i][j] = best;
        }
    }
    grid[a.len()][b.len()]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn suggests_a_close_key() {
        assert_eq!(suggest("modle", ["role", "model", "tools"]), Some("model".into()));
        assert_eq!(suggest("buildr", ["builder", "commander"]), Some("builder".into()));
    }

    #[test]
    fn stays_quiet_when_nothing_is_close() {
        assert_eq!(suggest("xyz", ["role", "model"]), None);
        assert_eq!(suggest("a", ["b"]), None);
    }
}

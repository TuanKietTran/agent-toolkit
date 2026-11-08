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
    /// Byte length of the offending token (from its `Span`); the renderer underlines
    /// that many characters starting at `col`. `0` renders as a single caret.
    pub len: u32,
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
            len: at.len,
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

/// An ordered list of problems. The lexer stops at the first one; the parser recovers and
/// collects up to 20; `resolve` and `schema` collect all of them.
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
    pub fn render(&self, source: &str) -> String {
        if self.0.is_empty() {
            return String::new();
        }
        let lines: Vec<&str> = source.lines().collect();
        let mut blocks: Vec<String> = Vec::with_capacity(self.0.len());
        for d in &self.0 {
            let severity = match d.severity {
                Severity::Error => "Error",
                Severity::Warning => "Warning",
            };
            let mut block = format!("{severity}: {}", d.summary);
            block.push_str("\n\n");
            block.push_str(&format!("  on {} line {}", d.file, d.line));
            if let Some(context) = &d.context {
                block.push_str(&format!(", in {context}"));
            }
            block.push(':');
            if let Some(text) = d.line.checked_sub(1).and_then(|i| lines.get(i as usize)) {
                let text = text.trim_end();
                block.push_str(&format!("\n  {}: {}", d.line, text));
                // Caret line under the exact token: the source text starts after
                // the "  " + line-digits + ": " prefix, then `col - 1` characters in.
                let col0 = d.col.saturating_sub(1) as usize;
                let line_chars = text.chars().count();
                if col0 < line_chars {
                    let carets = (d.len.max(1) as usize).min(line_chars - col0);
                    let indent = 2 + d.line.to_string().len() + 2 + col0;
                    block.push_str(&format!("\n{}{}", " ".repeat(indent), "^".repeat(carets)));
                }
            }
            block.push_str("\n\n");
            block.push_str(&d.detail);
            if let Some(hint) = &d.hint {
                block.push_str("\n\n");
                block.push_str(hint);
            }
            blocks.push(block);
        }
        let mut out = blocks.join("\n\n");
        out.push('\n');
        out
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
    for (j, cell) in grid[0].iter_mut().enumerate() {
        *cell = j;
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

    fn make_diag(severity: Severity, line: u32, summary: &str, detail: &str) -> Diagnostic {
        Diagnostic {
            severity,
            file: "team.yah".to_owned(),
            line,
            col: 3,
            len: 1,
            summary: summary.to_owned(),
            detail: detail.to_owned(),
            context: None,
            hint: None,
        }
    }

    #[test]
    fn render_matches_terraform_golden() {
        let mut source_lines: Vec<String> = (1..=30).map(|i| format!("filler {i}")).collect();
        source_lines.push("  modle = \"sonnet\"".to_owned());
        let source = source_lines.join("\n");
        let d = make_diag(Severity::Error, 31, "Unsupported argument", "An argument named \"modle\" is not expected here.")
            .with_context("harness \"builder\"")
            .with_hint("Did you mean \"model\"?");
        let expected = "Error: Unsupported argument\n\n  on team.yah line 31, in harness \"builder\":\n  31:   modle = \"sonnet\"\n        ^\n\nAn argument named \"modle\" is not expected here.\n\nDid you mean \"model\"?\n";
        assert_eq!(Diagnostics(vec![d]).render(&source), expected);
    }

    #[test]
    fn render_warning_without_context_or_hint() {
        let source = "yah 1\nx = 1\n";
        let d = make_diag(Severity::Warning, 2, "Heads up", "Something happened.");
        let expected = "Warning: Heads up\n\n  on team.yah line 2:\n  2: x = 1\n       ^\n\nSomething happened.\n";
        assert_eq!(Diagnostics(vec![d]).render(source), expected);
    }

    #[test]
    fn render_underlines_exact_token() {
        let mut source_lines: Vec<String> = (1..=30).map(|i| format!("filler {i}")).collect();
        source_lines.push("  modle = \"sonnet\"".to_owned());
        let source = source_lines.join("\n");
        let mut d = make_diag(Severity::Error, 31, "Unsupported argument", "An argument named \"modle\" is not expected here.");
        d.len = 5;
        let out = Diagnostics(vec![d]).render(&source);
        assert!(out.contains("\n  31:   modle = \"sonnet\"\n        ^^^^^\n"), "got: {out:?}");
    }

    #[test]
    fn render_skips_missing_source_line() {
        let source = "yah 1\n";
        let d = make_diag(Severity::Error, 99, "Gone", "No such line.");
        let expected = "Error: Gone\n\n  on team.yah line 99:\n\nNo such line.\n";
        assert_eq!(Diagnostics(vec![d]).render(source), expected);
    }

    #[test]
    fn render_separates_multiple_with_one_blank_line() {
        let source = "a\nb\n";
        let d1 = make_diag(Severity::Error, 1, "First", "Detail one.");
        let d2 = make_diag(Severity::Warning, 2, "Second", "Detail two.");
        let out = Diagnostics(vec![d1, d2]).render(source);
        let expected = "Error: First\n\n  on team.yah line 1:\n  1: a\n\nDetail one.\n\nWarning: Second\n\n  on team.yah line 2:\n  2: b\n\nDetail two.\n";
        assert_eq!(out, expected);
        assert!(out.ends_with('\n') && !out.ends_with("\n\n"));
    }

    #[test]
    fn render_empty_diagnostics_is_empty() {
        assert_eq!(Diagnostics::default().render("anything"), "");
    }

    #[test]
    fn render_trims_trailing_whitespace_keeps_indent() {
        let source = "yah 1\n    key = 1   \n";
        let d = make_diag(Severity::Error, 2, "S", "D.");
        let out = Diagnostics(vec![d]).render(source);
        assert!(out.contains("\n  2:     key = 1\n"), "got: {out:?}");
    }
}

//! Tokens. OWNER: gl-syntax (lexer.rs and parser.rs).
//!
//! Rules (docs/graphspec.md): UTF-8; `//` comments to end of line; indentation insignificant;
//! identifiers `[a-zA-Z_][a-zA-Z0-9_-]*`; double-quoted strings `"[^"]*"` (may contain `${...}`,
//! may span lines, no escapes); raw backtick strings; numbers; `{ } [ ] = , .`.
//! The header is lexed as the identifier `yah` followed by a number.

use crate::ast::Span;
use crate::diag::Diagnostics;

#[derive(Debug, Clone, PartialEq)]
pub enum Tok {
    Ident(String),
    /// Text between the double quotes, verbatim (interpolations are split by the parser).
    Str(String),
    /// Text between backticks, verbatim. Never interpolated.
    Raw(String),
    Num(f64),
    LBrace,
    RBrace,
    LBracket,
    RBracket,
    Eq,
    Comma,
    Dot,
    Eof,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Token {
    pub tok: Tok,
    pub span: Span,
}

/// Tokenize `src`. Stops at the first error (unterminated string, stray character).
pub fn lex(_file: &str, _src: &str) -> Result<Vec<Token>, Diagnostics> {
    todo!("gl-syntax: lexer")
}

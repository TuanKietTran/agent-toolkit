//! The syntax tree the parser produces. SHARED CONTRACT (docs/graphspec.md, "Grammar").
//!
//! ```text
//! file      := header statement*
//! statement := block | assignment
//! block     := identifier string? "{" statement* "}"
//! assignment:= identifier "=" value
//! value     := string | number | bool | null | list | map | reference
//! ```
//!
//! Interpolations (`${...}`) are split out of double-quoted strings into [`StrPart::Interp`].
//! Raw backtick strings are a single [`StrPart::Lit`] and never interpolate.
//! A bare `true` / `false` / `null` is a keyword value, never a reference.

use serde::Serialize;

/// 1-based position of the first character of a token.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize)]
pub struct Span {
    pub line: u32,
    pub col: u32,
    /// 0-based byte offset of the first character into the source.
    pub offset: u32,
    /// Byte length of the token (0 for synthetic spans with no source token).
    pub len: u32,
}

#[derive(Debug, Clone, PartialEq)]
pub struct File {
    /// File name as given to the loader, for diagnostics.
    pub name: String,
    /// The integer after `yah` in the header.
    pub version: u32,
    pub stmts: Vec<Stmt>,
    /// Comments not attached to any statement: everything after the last
    /// statement, or all comments in a file with no statements. Full `//...`
    /// text in source order, no trailing newline.
    pub tail_comments: Vec<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Stmt {
    Block(Block),
    Assign(Assign),
}

/// `harness "builder" { ... }` (label present) or `open { ... }` (no label).
#[derive(Debug, Clone, PartialEq)]
pub struct Block {
    pub kind: String,
    pub label: Option<String>,
    pub body: Vec<Stmt>,
    pub span: Span,
    /// `//` comments on the lines immediately above this block, full text, source order.
    pub leading: Vec<String>,
    /// `//` comment on the same line as this block's closing `}`, if any.
    pub trailing: Option<String>,
}

/// `key = value`. Also the entries of a map value.
#[derive(Debug, Clone, PartialEq)]
pub struct Assign {
    pub key: String,
    pub value: Expr,
    /// Position of the key.
    pub span: Span,
    /// `//` comments on the lines immediately above this assignment, full text, source order.
    pub leading: Vec<String>,
    /// `//` comment on the same line after this assignment's value, if any.
    pub trailing: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Expr {
    pub kind: ExprKind,
    pub span: Span,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ExprKind {
    /// A string, split into literal text and interpolations. `""` is `Str(vec![])`.
    Str(Vec<StrPart>),
    Num(f64),
    Bool(bool),
    Null,
    List(Vec<Expr>),
    Map(Vec<Assign>),
    /// `env.NAME`, `var.name`, `harnesses.builder.model`: dotted identifiers.
    Ref(Vec<String>),
}

#[derive(Debug, Clone, PartialEq)]
pub enum StrPart {
    Lit(String),
    /// `${env.NAME}` -> `["env","NAME"]`. v1 expressions are reference paths only.
    ///
    /// EXTENSION POINT: this is the ONLY expression form today — `.yah` is a declarative
    /// language and no interpreter is wanted. A future `Expr::Call` or conditional form
    /// would go here, as a new expression form alongside this one, resolved by the same
    /// resolver pass; until then, `Interp` (a reference path) is the only form.
    Interp(Vec<String>, Span),
}

impl Block {
    /// The assignment called `key` directly inside this block.
    pub fn assign(&self, key: &str) -> Option<&Assign> {
        self.body.iter().find_map(|s| match s {
            Stmt::Assign(a) if a.key == key => Some(a),
            _ => None,
        })
    }

    /// The nested block called `kind` directly inside this block (e.g. `open`).
    pub fn block(&self, kind: &str) -> Option<&Block> {
        self.body.iter().find_map(|s| match s {
            Stmt::Block(b) if b.kind == kind => Some(b),
            _ => None,
        })
    }
}

impl Expr {
    pub fn str_lit(text: &str, span: Span) -> Expr {
        let parts = if text.is_empty() { vec![] } else { vec![StrPart::Lit(text.to_owned())] };
        Expr { kind: ExprKind::Str(parts), span }
    }
}

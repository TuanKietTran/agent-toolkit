//! Recursive-descent parser.

use crate::yah::ast::{self, Expr, ExprKind, Span, StrPart};
use crate::yah::diag::{Diagnostic, Diagnostics};
use crate::yah::lexer::{self, Tok, Token};

const HEADER_DETAIL: &str = "The first non-comment line of a .yah file must be \"yah 1\".";

fn err(file: &str, span: Span, summary: &str, detail: impl Into<String>) -> Diagnostics {
    Diagnostics::one(Diagnostic::error(file, span, summary, detail))
}

fn is_ident(s: &str) -> bool {
    let mut chars = s.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() || c == '_' => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// Split a double-quoted string's text into literal and interpolation parts.
/// `str_span` is the position of the opening quote; content starts one column later.
fn split_string(file: &str, text: &str, str_span: Span) -> Result<Vec<StrPart>, Diagnostics> {
    let chars: Vec<char> = text.chars().collect();
    let mut parts: Vec<StrPart> = Vec::new();
    let mut lit = String::new();
    let mut line = str_span.line;
    let mut col = str_span.col + 1;
    let mut byte_off = str_span.offset + 1;
    let mut i = 0usize;
    while i < chars.len() {
        let c = chars[i];
        if c == '$' && i + 1 < chars.len() && chars[i + 1] == '{' {
            let dollar_span = Span {
                line,
                col,
                offset: byte_off,
                len: 0,
            };
            // Find the closing '}'.
            let mut j = i + 2;
            let mut found = false;
            while j < chars.len() {
                if chars[j] == '}' {
                    found = true;
                    break;
                }
                j += 1;
            }
            if !found {
                return Err(err(
                    file,
                    dollar_span,
                    "Invalid interpolation",
                    "Unterminated interpolation: '${' has no closing '}'.",
                ));
            }
            let dollar_span = Span {
                len: chars[i..=j].iter().map(|ch| ch.len_utf8() as u32).sum(),
                ..dollar_span
            };
            let inner: String = chars[i + 2..j].iter().collect();
            let trimmed = inner.trim();
            if trimmed.is_empty() {
                return Err(err(
                    file,
                    dollar_span,
                    "Invalid interpolation",
                    "Invalid interpolation: '${}' is empty.",
                ));
            }
            let mut path: Vec<String> = Vec::new();
            let mut valid = true;
            for seg in trimmed.split('.') {
                let seg = seg.trim();
                if !is_ident(seg) {
                    valid = false;
                    break;
                }
                path.push(seg.to_string());
            }
            if !valid || path.is_empty() {
                return Err(err(
                    file,
                    dollar_span,
                    "Invalid interpolation",
                    format!(
                        "Invalid interpolation '${{{inner}}}': expected a dotted reference path."
                    ),
                ));
            }
            if !lit.is_empty() {
                parts.push(StrPart::Lit(std::mem::take(&mut lit)));
            }
            parts.push(StrPart::Interp(path, dollar_span));
            // Advance position past '${...}'.
            while i <= j {
                if chars[i] == '\n' {
                    line += 1;
                    col = 1;
                } else {
                    col += 1;
                }
                byte_off += chars[i].len_utf8() as u32;
                i += 1;
            }
        } else {
            lit.push(c);
            byte_off += c.len_utf8() as u32;
            if c == '\n' {
                line += 1;
                col = 1;
            } else {
                col += 1;
            }
            i += 1;
        }
    }
    if !lit.is_empty() {
        parts.push(StrPart::Lit(lit));
    }
    Ok(parts)
}

/// Maximum number of syntax diagnostics collected in one parse (S5 error recovery).
const MAX_ERRORS: usize = 20;

struct Parser {
    tokens: Vec<Token>,
    pos: usize,
    file: String,
    /// Syntax errors recovered from so far (capped at `MAX_ERRORS`).
    errors: Diagnostics,
    /// Comment trivia collected but not yet attached to a statement (S4),
    /// in source order.
    pending: Vec<(String, Span)>,
}

impl Parser {
    fn peek(&self) -> &Tok {
        &self.tokens[self.pos.min(self.tokens.len() - 1)].tok
    }

    fn peek_span(&self) -> Span {
        self.tokens[self.pos.min(self.tokens.len() - 1)].span
    }

    fn bump(&mut self) -> Token {
        let t = self.tokens[self.pos.min(self.tokens.len() - 1)].clone();
        if t.tok != Tok::Eof && self.pos + 1 < self.tokens.len() {
            self.pos += 1;
        }
        t
    }

    fn error(&self, span: Span, summary: &str, detail: impl Into<String>) -> Diagnostics {
        err(&self.file, span, summary, detail)
    }

    /// Record recovered diagnostics, capped at `MAX_ERRORS`.
    fn record(&mut self, diags: Diagnostics) {
        for d in diags.0 {
            if self.errors.0.len() >= MAX_ERRORS {
                break;
            }
            self.errors.push(d);
        }
    }

    /// Move any comment tokens at the cursor into `pending`, in source order.
    fn collect_comments(&mut self) {
        while let Tok::Comment(text) = self.peek().clone() {
            let span = self.peek_span();
            self.pending.push((text, span));
            self.bump();
        }
    }

    /// Drain `pending`, returning just the comment texts in source order.
    fn take_pending(&mut self) -> Vec<String> {
        self.pending.drain(..).map(|(text, _)| text).collect()
    }

    /// Line of the most recently consumed non-comment token (1 if none).
    fn last_consumed_line(&self) -> u32 {
        let upto = self.pos.min(self.tokens.len());
        self.tokens[..upto]
            .iter()
            .rev()
            .find(|t| !matches!(t.tok, Tok::Comment(_)))
            .map(|t| t.span.line)
            .unwrap_or(1)
    }

    fn peek_at(&self, offset: usize) -> &Tok {
        &self.tokens[(self.pos + offset).min(self.tokens.len() - 1)].tok
    }

    /// Does the token at the cursor start a statement (`key =`, `kind {`, `kind "label" {`)?
    fn at_statement_start(&self) -> bool {
        if !matches!(self.peek(), Tok::Ident(_)) {
            return false;
        }
        match self.peek_at(1) {
            Tok::Eq | Tok::LBrace => true,
            Tok::Str(_) => matches!(self.peek_at(2), Tok::LBrace),
            _ => false,
        }
    }

    /// Stack of still-unclosed openers (`{`/`[`) among the tokens consumed
    /// since `start_pos` — i.e. which maps/lists the statement that started
    /// at `start_pos` was inside when it failed. A closer pops only its
    /// matching opener (and anything opened after it); a mismatched closer
    /// pops nothing, so a block's `}` is never counted as closing a list.
    fn unclosed_stack_since(&self, start_pos: usize) -> Vec<Tok> {
        let mut stack: Vec<Tok> = Vec::new();
        for t in &self.tokens[start_pos..self.pos.min(self.tokens.len())] {
            match t.tok {
                Tok::LBrace | Tok::LBracket => stack.push(t.tok.clone()),
                Tok::RBrace => {
                    if let Some(pos) = stack.iter().rposition(|o| *o == Tok::LBrace) {
                        stack.truncate(pos);
                    }
                }
                Tok::RBracket => {
                    if let Some(pos) = stack.iter().rposition(|o| *o == Tok::LBracket) {
                        stack.truncate(pos);
                    }
                }
                _ => {}
            }
        }
        stack
    }

    /// Recovery (depth-aware): skip tokens until the nesting depth is back
    /// to the failing statement's starting depth AND a synchronisation point
    /// is reached — EOF, the enclosing block's `}` (left unconsumed when
    /// `in_block`; a stray `}` at top level is skipped like other garbage),
    /// or an identifier on a later line than the error that starts a
    /// statement. While `depth > 0` every token is consumed and counted:
    /// a `}` that closes a map/list opened by the failing statement must
    /// never be mistaken for the enclosing block's `}`, and a block's real
    /// `}` must never be reported as a statement. Passing
    /// `err_line = u32::MAX` skips to `}`/EOF only. Every non-sync token is
    /// consumed, so this always terminates; callers handle the sync token
    /// (`}`/EOF) themselves.
    fn synchronise(&mut self, err_line: u32, in_block: bool, mut stack: Vec<Tok>) {
        loop {
            if *self.peek() == Tok::Eof {
                break;
            }
            if stack.is_empty() {
                match self.peek() {
                    Tok::RBrace if in_block => break,
                    Tok::Ident(_)
                        if self.peek_span().line > err_line && self.at_statement_start() =>
                    {
                        break;
                    }
                    _ => {}
                }
            } else if *self.peek() == Tok::RBrace && in_block && !stack.contains(&Tok::LBrace) {
                // A `}` cannot close an unclosed list: with no `{` on the
                // stack this is the enclosing block's `}` — leave it for
                // the block parser instead of consuming it as the list's.
                break;
            }
            match self.bump().tok {
                Tok::LBrace => stack.push(Tok::LBrace),
                Tok::LBracket => stack.push(Tok::LBracket),
                Tok::RBrace => {
                    if let Some(pos) = stack.iter().rposition(|o| *o == Tok::LBrace) {
                        stack.truncate(pos);
                    }
                }
                Tok::RBracket => {
                    if let Some(pos) = stack.iter().rposition(|o| *o == Tok::LBracket) {
                        stack.truncate(pos);
                    }
                }
                _ => {}
            }
        }
    }

    /// Parse a block body, recovering from each bad statement: record the
    /// diagnostic, synchronise, and keep parsing the rest of the block.
    /// Infallible by design — recovered errors live in `self.errors`. An
    /// unclosed block at EOF records exactly one extra diagnostic, unless a
    /// statement error already ended at EOF.
    fn parse_statements_until_brace(&mut self, opener: Span) -> Vec<ast::Stmt> {
        let mut body = Vec::new();
        loop {
            self.collect_comments();
            match self.peek() {
                Tok::RBrace => {
                    self.bump();
                    break;
                }
                Tok::Eof => {
                    let d = self.error(
                        opener,
                        "Unclosed block",
                        "The block starting here is not closed.",
                    );
                    self.record(d);
                    break;
                }
                _ => {
                    if self.errors.0.len() >= MAX_ERRORS {
                        // Cap reached: skip the rest of this block.
                        self.synchronise(u32::MAX, true, Vec::new());
                        if matches!(self.peek(), Tok::RBrace) {
                            self.bump();
                        }
                        break;
                    }
                    let start_pos = self.pos;
                    match self.parse_statement() {
                        Ok(stmt) => body.push(stmt),
                        Err(diags) => {
                            let err_line = diags
                                .0
                                .first()
                                .map(|d| d.line)
                                .unwrap_or_else(|| self.peek_span().line);
                            let depth = self.unclosed_stack_since(start_pos);
                            self.record(diags);
                            if *self.peek() == Tok::Eof {
                                break;
                            }
                            self.synchronise(err_line, true, depth);
                            if *self.peek() == Tok::Eof {
                                break;
                            }
                        }
                    }
                }
            }
        }
        body
    }

    fn parse_block_body(&mut self) -> Vec<ast::Stmt> {
        // Caller has verified the peek is '{'.
        let opener = self.peek_span();
        self.bump();
        self.parse_statements_until_brace(opener)
    }

    /// Parse one statement and attach comment trivia to it (S4). Comments
    /// collected before the statement are its `leading`; comments collected
    /// while parsing it (inside a list/map, or in a block body after its last
    /// inner statement) are hoisted onto its `leading` too, in source order;
    /// the last comment on the line the statement ends on is its `trailing`;
    /// comments on later lines stay pending for the next statement, or become
    /// the file's `tail_comments` at EOF.
    fn parse_statement(&mut self) -> Result<ast::Stmt, Diagnostics> {
        self.collect_comments();
        let mut leading: Vec<String> = self.take_pending();
        let mut stmt = self.parse_statement_bare()?;
        let end_line = self.last_consumed_line();
        self.collect_comments();
        let pending = std::mem::take(&mut self.pending);
        let trail_idx = pending.iter().rposition(|(_, s)| s.line == end_line);
        let mut trailing = None;
        for (i, (text, span)) in pending.into_iter().enumerate() {
            if Some(i) == trail_idx {
                trailing = Some(text);
            } else if span.line <= end_line {
                leading.push(text);
            } else {
                self.pending.push((text, span));
            }
        }
        match &mut stmt {
            ast::Stmt::Assign(a) => {
                a.leading = leading;
                a.trailing = trailing;
            }
            ast::Stmt::Block(b) => {
                b.leading = leading;
                b.trailing = trailing;
            }
        }
        Ok(stmt)
    }

    fn parse_statement_bare(&mut self) -> Result<ast::Stmt, Diagnostics> {
        let start_span = self.peek_span();
        if let Tok::Error(d) = self.peek().clone() {
            // A lexical error standing where a statement starts: report it
            // exactly once and let the caller's recovery continue.
            self.bump();
            return Err(Diagnostics::one(d));
        }
        let Tok::Ident(kind) = self.peek().clone() else {
            return Err(self.error(
                start_span,
                "Expected statement",
                "Expected a block or an assignment.",
            ));
        };
        let ident_span = start_span;
        self.bump();
        self.collect_comments();
        match self.peek().clone() {
            Tok::Eq => {
                self.bump();
                let value = self.parse_value()?;
                Ok(ast::Stmt::Assign(ast::Assign {
                    key: kind,
                    value,
                    span: ident_span,
                    leading: Vec::new(),
                    trailing: None,
                }))
            }
            Tok::LBrace => {
                let body = self.parse_block_body();
                Ok(ast::Stmt::Block(ast::Block {
                    kind,
                    label: None,
                    body,
                    span: ident_span,
                    leading: Vec::new(),
                    trailing: None,
                }))
            }
            Tok::Str(label) => {
                self.bump();
                self.collect_comments();
                if *self.peek() != Tok::LBrace {
                    let span = self.peek_span();
                    return Err(self.error(
                        span,
                        "Expected \"=\" or \"{\"",
                        "Expected \"{\" after a block label.",
                    ));
                }
                let body = self.parse_block_body();
                Ok(ast::Stmt::Block(ast::Block {
                    kind,
                    label: Some(label),
                    body,
                    span: ident_span,
                    leading: Vec::new(),
                    trailing: None,
                }))
            }
            _ => {
                let span = self.peek_span();
                Err(self.error(
                    span,
                    "Expected \"=\" or \"{\"",
                    "Expected \"=\" or \"{\" after an identifier.",
                ))
            }
        }
    }

    fn parse_value(&mut self) -> Result<Expr, Diagnostics> {
        self.collect_comments();
        let span = self.peek_span();
        match self.peek().clone() {
            Tok::Error(d) => {
                self.bump();
                Err(Diagnostics::one(d))
            }
            Tok::Str(text) => {
                self.bump();
                let parts = split_string(&self.file, &text, span)?;
                Ok(Expr {
                    kind: ExprKind::Str(parts),
                    span,
                })
            }
            Tok::Raw(text) => {
                self.bump();
                Ok(Expr {
                    kind: ExprKind::Str(vec![StrPart::Lit(text)]),
                    span,
                })
            }
            Tok::Num(n) => {
                self.bump();
                Ok(Expr {
                    kind: ExprKind::Num(n),
                    span,
                })
            }
            Tok::Ident(first) => {
                self.bump();
                if *self.peek() != Tok::Dot {
                    match first.as_str() {
                        "true" => {
                            return Ok(Expr {
                                kind: ExprKind::Bool(true),
                                span,
                            });
                        }
                        "false" => {
                            return Ok(Expr {
                                kind: ExprKind::Bool(false),
                                span,
                            });
                        }
                        "null" => {
                            return Ok(Expr {
                                kind: ExprKind::Null,
                                span,
                            });
                        }
                        _ => {}
                    }
                }
                let mut segments = vec![first];
                while *self.peek() == Tok::Dot {
                    self.bump();
                    let seg_span = self.peek_span();
                    let Tok::Ident(seg) = self.peek().clone() else {
                        return Err(self.error(
                            seg_span,
                            "Expected identifier",
                            "Expected an identifier after '.'.",
                        ));
                    };
                    self.bump();
                    segments.push(seg);
                }
                Ok(Expr {
                    kind: ExprKind::Ref(segments),
                    span,
                })
            }
            Tok::LBracket => {
                self.bump();
                let mut items = Vec::new();
                loop {
                    self.collect_comments();
                    match self.peek() {
                        Tok::RBracket => {
                            self.bump();
                            break;
                        }
                        Tok::Eof => {
                            return Err(self.error(
                                span,
                                "Unclosed list",
                                "The list starting here is not closed.",
                            ));
                        }
                        _ => {}
                    }
                    items.push(self.parse_value()?);
                    self.collect_comments();
                    match self.peek() {
                        Tok::Comma => {
                            self.bump();
                        }
                        Tok::RBracket => {}
                        Tok::Eof => {
                            return Err(self.error(
                                span,
                                "Unclosed list",
                                "The list starting here is not closed.",
                            ));
                        }
                        _ => {
                            let s = self.peek_span();
                            return Err(self.error(
                                s,
                                "Expected \",\" or \"]\"",
                                "Expected \",\" or \"]\" in a list.",
                            ));
                        }
                    }
                }
                Ok(Expr {
                    kind: ExprKind::List(items),
                    span,
                })
            }
            Tok::LBrace => {
                self.bump();
                let mut entries = Vec::new();
                loop {
                    self.collect_comments();
                    match self.peek() {
                        Tok::RBrace => {
                            self.bump();
                            break;
                        }
                        Tok::Eof => {
                            return Err(self.error(
                                span,
                                "Unclosed map",
                                "The map starting here is not closed.",
                            ));
                        }
                        _ => {}
                    }
                    let key_span = self.peek_span();
                    let Tok::Ident(key) = self.peek().clone() else {
                        return Err(self.error(
                            key_span,
                            "Expected identifier",
                            "Expected a key in a map.",
                        ));
                    };
                    self.bump();
                    if *self.peek() != Tok::Eq {
                        let s = self.peek_span();
                        return Err(self.error(
                            s,
                            "Expected \"=\"",
                            "Expected \"=\" after a map key.",
                        ));
                    }
                    self.bump();
                    let value = self.parse_value()?;
                    entries.push(ast::Assign {
                        key,
                        value,
                        span: key_span,
                        leading: Vec::new(),
                        trailing: None,
                    });
                    self.collect_comments();
                    if *self.peek() == Tok::Comma {
                        self.bump();
                    }
                }
                Ok(Expr {
                    kind: ExprKind::Map(entries),
                    span,
                })
            }
            _ => Err(self.error(span, "Expected value", "Expected a value.")),
        }
    }
}

/// Lex and parse `src`. Checks the `yah N` header (N must be 1 in this version) and the grammar.
/// Header errors are fatal (a single diagnostic); statement-level syntax errors are recovered
/// from, collecting up to 20 diagnostics in one run. Does NOT check which blocks or keys
/// are allowed (that is `schema`), nor top-level assignments (also `schema`).
pub fn parse(file: &str, src: &str) -> Result<ast::File, Diagnostics> {
    let tokens = lexer::lex(file, src);
    // Header: Ident("yah") then Num(1).
    // Comments before the header, or between `yah` and the version, are
    // trivia: skip them for the header check, keep them as pending.
    let mut idx = 0;
    let mut initial_pending: Vec<(String, Span)> = Vec::new();
    while let Some(t) = tokens.get(idx) {
        match &t.tok {
            Tok::Comment(text) => {
                initial_pending.push((text.clone(), t.span));
                idx += 1;
            }
            _ => break,
        }
    }
    let first = tokens.get(idx).cloned().unwrap_or(Token {
        tok: Tok::Eof,
        span: Span {
            line: 1,
            col: 1,
            offset: 0,
            len: 0,
        },
    });
    if let Tok::Error(d) = &first.tok {
        return Err(Diagnostics::one(d.clone()));
    }
    if first.tok != Tok::Ident("yah".to_string()) {
        return Err(err(
            file,
            first.span,
            "Missing or unsupported header",
            HEADER_DETAIL,
        ));
    }
    let mut vidx = idx + 1;
    while let Some(t) = tokens.get(vidx) {
        match &t.tok {
            Tok::Comment(text) => {
                initial_pending.push((text.clone(), t.span));
                vidx += 1;
            }
            _ => break,
        }
    }
    let second = tokens.get(vidx).cloned().unwrap_or(Token {
        tok: Tok::Eof,
        span: first.span,
    });
    let Tok::Num(version_num) = second.tok else {
        return Err(err(
            file,
            second.span,
            "Missing or unsupported header",
            HEADER_DETAIL,
        ));
    };
    if version_num.fract() != 0.0 {
        return Err(err(
            file,
            second.span,
            "Missing or unsupported header",
            HEADER_DETAIL,
        ));
    }
    if version_num != 1.0 {
        return Err(err(
            file,
            second.span,
            "Unsupported version",
            format!(
                "Unsupported version {}; only version 1 is supported.",
                version_num as i64
            ),
        ));
    }
    let mut parser = Parser {
        tokens,
        pos: vidx + 1,
        file: file.to_string(),
        errors: Diagnostics::default(),
        pending: initial_pending,
    };
    let mut stmts = Vec::new();
    loop {
        parser.collect_comments();
        if *parser.peek() == Tok::Eof {
            break;
        }
        if parser.errors.0.len() >= MAX_ERRORS {
            break;
        }
        let start_pos = parser.pos;
        match parser.parse_statement() {
            Ok(stmt) => stmts.push(stmt),
            Err(diags) => {
                let err_line = diags
                    .0
                    .first()
                    .map(|d| d.line)
                    .unwrap_or_else(|| parser.peek_span().line);
                let depth = parser.unclosed_stack_since(start_pos);
                parser.record(diags);
                if *parser.peek() == Tok::Eof {
                    break;
                }
                parser.synchronise(err_line, false, depth);
            }
        }
    }
    let tail_comments = parser.take_pending();
    let errors = std::mem::take(&mut parser.errors);
    errors.into_result(ast::File {
        name: file.to_string(),
        version: 1,
        stmts,
        tail_comments,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::yah::ast::{Stmt, StrPart};

    fn ok(src: &str) -> ast::File {
        parse("test.yah", src).unwrap()
    }

    fn err1(src: &str) -> Diagnostic {
        let d = parse("test.yah", src).unwrap_err();
        assert_eq!(d.0.len(), 1, "{d:?}");
        d.0[0].clone()
    }

    fn first_assign(f: &ast::File) -> &ast::Assign {
        match &f.stmts[0] {
            Stmt::Assign(a) => a,
            other => panic!("expected assign, got {other:?}"),
        }
    }

    fn first_block(f: &ast::File) -> &ast::Block {
        match &f.stmts[0] {
            Stmt::Block(b) => b,
            other => panic!("expected block, got {other:?}"),
        }
    }

    #[test]
    fn canonical_fixture_structure() {
        let src = include_str!("../../tests/fixtures/canonical.yah");
        let f = ok(src);
        assert_eq!(f.version, 1);
        assert_eq!(f.name, "test.yah");
        let kinds: Vec<&str> = f
            .stmts
            .iter()
            .map(|s| match s {
                Stmt::Block(b) => b.kind.as_str(),
                Stmt::Assign(_) => "<assign>",
            })
            .collect();
        assert_eq!(
            kinds,
            vec![
                "variable",
                "defaults",
                "provider",
                "model",
                "system_one",
                "api",
                "harness",
                "harness",
                "team"
            ]
        );
        let labels: Vec<Option<&str>> = f
            .stmts
            .iter()
            .map(|s| match s {
                Stmt::Block(b) => b.label.as_deref(),
                _ => None,
            })
            .collect();
        assert_eq!(labels[0], Some("work_dir"));
        assert_eq!(labels[1], None);
        assert_eq!(labels[2], Some("anthropic"));
        assert_eq!(labels[7], Some("builder"));
    }

    #[test]
    fn canonical_refs_lists_and_nested_open() {
        let src = include_str!("../../tests/fixtures/canonical.yah");
        let f = ok(src);
        // provider api_key = env.ANTHROPIC_API_KEY
        let provider = match &f.stmts[2] {
            Stmt::Block(b) => b,
            _ => panic!(),
        };
        assert_eq!(
            provider.assign("api_key").unwrap().value.kind,
            ExprKind::Ref(vec!["env".into(), "ANTHROPIC_API_KEY".into()])
        );
        // api command list, last item is a ref
        let api = match &f.stmts[5] {
            Stmt::Block(b) => b,
            _ => panic!(),
        };
        let ExprKind::List(items) = &api.assign("command").unwrap().value.kind else {
            panic!()
        };
        assert_eq!(items.len(), 4);
        assert_eq!(
            items[3].kind,
            ExprKind::Ref(vec!["var".into(), "work_dir".into()])
        );
        // harness commander nested open block
        let commander = match &f.stmts[6] {
            Stmt::Block(b) => b,
            _ => panic!(),
        };
        let open = commander.block("open").unwrap();
        assert_eq!(open.label, None);
        assert_eq!(
            open.assign("cols").unwrap().value.kind,
            ExprKind::Num(140.0)
        );
        assert_eq!(open.assign("rows").unwrap().value.kind, ExprKind::Num(40.0));
        // builder open cwd = var.work_dir
        let builder = match &f.stmts[7] {
            Stmt::Block(b) => b,
            _ => panic!(),
        };
        assert_eq!(
            builder
                .block("open")
                .unwrap()
                .assign("cwd")
                .unwrap()
                .value
                .kind,
            ExprKind::Ref(vec!["var".into(), "work_dir".into()])
        );
        // team graph = true
        let team = match &f.stmts[8] {
            Stmt::Block(b) => b,
            _ => panic!(),
        };
        assert_eq!(
            team.assign("graph").unwrap().value.kind,
            ExprKind::Bool(true)
        );
    }

    #[test]
    fn header_only_file() {
        let f = ok("yah 1");
        assert!(f.stmts.is_empty());
        assert_eq!(f.version, 1);
    }

    #[test]
    fn header_after_comment() {
        let f = ok("// hello // yah 9\n// more\nyah 1\nx = 1");
        assert_eq!(f.stmts.len(), 1);
    }

    #[test]
    fn unsupported_version_yah_2() {
        let d = err1("yah 2");
        assert_eq!(d.summary, "Unsupported version");
        assert_eq!((d.line, d.col), (1, 5));
    }

    #[test]
    fn missing_header() {
        let d = err1("x = 1");
        assert_eq!(d.summary, "Missing or unsupported header");
        assert_eq!(
            d.detail,
            "The first non-comment line of a .yah file must be \"yah 1\"."
        );
        assert_eq!((d.line, d.col), (1, 1));
    }

    #[test]
    fn missing_header_empty_file() {
        let d = err1("");
        assert_eq!(d.summary, "Missing or unsupported header");
        assert_eq!((d.line, d.col), (1, 1));
    }

    #[test]
    fn non_integer_version_is_missing_header() {
        let d = err1("yah 1.5");
        assert_eq!(d.summary, "Missing or unsupported header");
        assert_eq!((d.line, d.col), (1, 5));
    }

    #[test]
    fn scalar_values() {
        let f = ok("yah 1\na = true\nb = false\nc = null\nd = -2.5\ne = \"hi\"");
        let kinds: Vec<ExprKind> = f
            .stmts
            .iter()
            .map(|s| match s {
                Stmt::Assign(a) => a.value.kind.clone(),
                _ => panic!(),
            })
            .collect();
        assert_eq!(
            kinds,
            vec![
                ExprKind::Bool(true),
                ExprKind::Bool(false),
                ExprKind::Null,
                ExprKind::Num(-2.5),
                ExprKind::Str(vec![StrPart::Lit("hi".into())])
            ]
        );
    }

    #[test]
    fn dotted_ref_values() {
        let f = ok("yah 1\nx = harnesses.builder.model");
        assert_eq!(
            first_assign(&f).value.kind,
            ExprKind::Ref(vec!["harnesses".into(), "builder".into(), "model".into()])
        );
    }

    #[test]
    fn empty_string_is_empty_parts() {
        let f = ok("yah 1\nx = \"\"");
        assert_eq!(first_assign(&f).value.kind, ExprKind::Str(vec![]));
    }

    #[test]
    fn raw_string_is_single_lit_no_interpolation() {
        let f = ok("yah 1\nx = `${var.x} and $`");
        assert_eq!(
            first_assign(&f).value.kind,
            ExprKind::Str(vec![StrPart::Lit("${var.x} and $".into())])
        );
    }

    #[test]
    fn empty_raw_is_single_empty_lit() {
        let f = ok("yah 1\nx = ``");
        assert_eq!(
            first_assign(&f).value.kind,
            ExprKind::Str(vec![StrPart::Lit(String::new())])
        );
    }

    #[test]
    fn interpolation_parts_and_span() {
        let f = ok("yah 1\nx = \"${env.A}-${var.b}\"");
        let ExprKind::Str(parts) = &first_assign(&f).value.kind else {
            panic!()
        };
        assert_eq!(parts.len(), 3);
        assert_eq!(
            parts[0],
            StrPart::Interp(
                vec!["env".into(), "A".into()],
                Span {
                    line: 2,
                    col: 6,
                    offset: 11,
                    len: 8
                }
            )
        );
        assert_eq!(parts[1], StrPart::Lit("-".into()));
        assert_eq!(
            parts[2],
            StrPart::Interp(
                vec!["var".into(), "b".into()],
                Span {
                    line: 2,
                    col: 15,
                    offset: 20,
                    len: 8
                }
            )
        );
    }

    #[test]
    fn interpolation_with_spaces() {
        let f = ok("yah 1\nx = \"a ${ var.x } b\"");
        let ExprKind::Str(parts) = &first_assign(&f).value.kind else {
            panic!()
        };
        assert_eq!(
            parts,
            &vec![
                StrPart::Lit("a ".into()),
                StrPart::Interp(
                    vec!["var".into(), "x".into()],
                    Span {
                        line: 2,
                        col: 8,
                        offset: 13,
                        len: 10
                    }
                ),
                StrPart::Lit(" b".into())
            ]
        );
    }

    #[test]
    fn multiline_string_interpolation_span() {
        let f = ok("yah 1\nx = \"line1\nline2 ${var.x} end\"");
        let ExprKind::Str(parts) = &first_assign(&f).value.kind else {
            panic!()
        };
        assert_eq!(parts.len(), 3);
        assert_eq!(parts[0], StrPart::Lit("line1\nline2 ".into()));
        assert_eq!(
            parts[1],
            StrPart::Interp(
                vec!["var".into(), "x".into()],
                Span {
                    line: 3,
                    col: 7,
                    offset: 23,
                    len: 8
                }
            )
        );
        assert_eq!(parts[2], StrPart::Lit(" end".into()));
    }

    #[test]
    fn dollar_not_followed_by_brace_is_literal() {
        let f = ok("yah 1\nx = \"cost $5 and $x\"");
        assert_eq!(
            first_assign(&f).value.kind,
            ExprKind::Str(vec![StrPart::Lit("cost $5 and $x".into())])
        );
    }

    #[test]
    fn invalid_interpolation_unterminated() {
        let d = err1("yah 1\nx = \"${var.x\"");
        assert_eq!(d.summary, "Invalid interpolation");
        assert_eq!((d.line, d.col), (2, 6));
    }

    #[test]
    fn invalid_interpolation_malformed() {
        for src in [
            "yah 1\nx = \"${}\"",
            "yah 1\nx = \"${123}\"",
            "yah 1\nx = \"${var..x}\"",
            "yah 1\nx = \"${var.}\"",
            "yah 1\nx = \"${.var}\"",
        ] {
            let d = err1(src);
            assert_eq!(d.summary, "Invalid interpolation", "src={src}");
            assert_eq!((d.line, d.col), (2, 6), "src={src}");
        }
    }

    #[test]
    fn lists_trailing_comma_and_ref_inside() {
        let f = ok("yah 1\nx = [1, \"a\", var.work_dir,]");
        let ExprKind::List(items) = &first_assign(&f).value.kind else {
            panic!()
        };
        assert_eq!(items.len(), 3);
        assert_eq!(
            items[2].kind,
            ExprKind::Ref(vec!["var".into(), "work_dir".into()])
        );
    }

    #[test]
    fn empty_list_and_empty_map() {
        let f = ok("yah 1\na = []\nb = {}");
        assert_eq!(
            match &f.stmts[0] {
                Stmt::Assign(a) => a.value.kind.clone(),
                _ => panic!(),
            },
            ExprKind::List(vec![])
        );
        assert_eq!(
            match &f.stmts[1] {
                Stmt::Assign(a) => a.value.kind.clone(),
                _ => panic!(),
            },
            ExprKind::Map(vec![])
        );
    }

    #[test]
    fn map_commas_optional_and_nested_map() {
        let f = ok("yah 1\nx = { a = 1 b = { c = 2, d = 3 } e = 4 }");
        let ExprKind::Map(entries) = &first_assign(&f).value.kind else {
            panic!()
        };
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0].key, "a");
        let ExprKind::Map(inner) = &entries[1].value.kind else {
            panic!()
        };
        assert_eq!(inner.len(), 2);
        assert_eq!(inner[1].key, "d");
    }

    #[test]
    fn comments_everywhere_and_trailing_commas() {
        let f = ok("// a\nyah 1 // b\n// c\nx = [ // d\n 1, // e\n 2, // f\n] // g");
        let ExprKind::List(items) = &first_assign(&f).value.kind else {
            panic!()
        };
        assert_eq!(items.len(), 2);
        // Defined place for out-of-statement comments (S4): everything before
        // or inside the statement, in source order, hoists to its `leading`
        // (pre-header // a and header-line // b included); the comment on the
        // line the statement ends on is its `trailing`.
        let a = first_assign(&f);
        assert_eq!(a.leading.join("\n"), "// a\n// b\n// c\n// d\n// e\n// f");
        assert_eq!(a.trailing.as_deref(), Some("// g"));
        assert!(f.tail_comments.is_empty());
    }

    #[test]
    fn trivia_leading_trailing_block_and_tail() {
        let f = ok(
            "yah 1\n// lead1\n// lead2\nx = 1 // trail\nblk \"b\" { // open note\n// inner lead\ny = 2\n// inner tail\n} // block trail\n// tail1\n// tail2\n",
        );
        let x = first_assign(&f);
        assert_eq!(x.leading.join("\n"), "// lead1\n// lead2");
        assert_eq!(x.trailing.as_deref(), Some("// trail"));
        let blk = match &f.stmts[1] {
            Stmt::Block(b) => b,
            other => panic!("expected block at stmts[1], got {other:?}"),
        };
        // Comment after the last inner statement hoists to the block's leading.
        assert_eq!(blk.leading.join("\n"), "// inner tail");
        assert_eq!(blk.trailing.as_deref(), Some("// block trail"));
        let y = blk.assign("y").unwrap();
        assert_eq!(y.leading.join("\n"), "// open note\n// inner lead");
        assert_eq!(y.trailing, None);
        assert_eq!(f.tail_comments.join("\n"), "// tail1\n// tail2");
    }

    #[test]
    fn trivia_comments_only_file_and_empty_block() {
        let f = ok("yah 1\n// only\n");
        assert!(f.stmts.is_empty());
        assert_eq!(f.tail_comments.join("\n"), "// only");
        let f2 = ok("yah 1\nblk {\n// in empty\n}\n");
        assert_eq!(first_block(&f2).leading.join("\n"), "// in empty");
    }

    #[test]
    fn labeled_and_unlabeled_blocks() {
        let f = ok("yah 1\nopen { x = 1 }");
        assert_eq!(first_block(&f).label, None);
        assert_eq!(first_block(&f).kind, "open");
        let f2 = ok("yah 1\nharness \"b\" { x = 1 }");
        assert_eq!(first_block(&f2).label, Some("b".into()));
    }

    #[test]
    fn deep_nesting() {
        let f = ok("yah 1\na { b { c { d { x = 1 } } } }");
        let a = first_block(&f);
        let b = a.block("b").unwrap();
        let c = b.block("c").unwrap();
        let d = c.block("d").unwrap();
        assert_eq!(d.assign("x").unwrap().value.kind, ExprKind::Num(1.0));
    }

    #[test]
    fn expected_eq_or_brace_error_position() {
        let d = err1("yah 1\nx 1");
        assert_eq!(d.summary, "Expected \"=\" or \"{\"");
        assert_eq!((d.line, d.col), (2, 3));
    }

    #[test]
    fn second_label_string_is_error() {
        let d = err1("yah 1\nharness \"a\" \"b\" { }");
        assert_eq!(d.summary, "Expected \"=\" or \"{\"");
        assert_eq!((d.line, d.col), (2, 13));
    }

    #[test]
    fn unclosed_block_points_at_opener() {
        let d = err1("yah 1\nopen {\n x = 1\n");
        assert_eq!(d.summary, "Unclosed block");
        assert_eq!((d.line, d.col), (2, 6));
    }

    #[test]
    fn unclosed_list_points_at_opener() {
        let d = err1("yah 1\nx = [1,\n");
        assert_eq!(d.summary, "Unclosed list");
        assert_eq!((d.line, d.col), (2, 5));
    }

    #[test]
    fn unclosed_map_points_at_opener() {
        let d = err1("yah 1\nx = { a = 1\n");
        assert_eq!(d.summary, "Unclosed map");
        assert_eq!((d.line, d.col), (2, 5));
    }

    #[test]
    fn crlf_file() {
        let f = ok("yah 1\r\nx = \"a\"\r\nopen {\r\n y = 2\r\n}");
        assert_eq!(f.stmts.len(), 2);
    }

    #[test]
    fn non_ascii_strings_and_comments() {
        let f = ok("// caf\u{e9}\nyah 1\nx = \"caf\u{e9} \u{2615} \u{65e5}\u{672c}\u{8a9e}\"");
        assert_eq!(
            first_assign(&f).value.kind,
            ExprKind::Str(vec![StrPart::Lit(
                "caf\u{e9} \u{2615} \u{65e5}\u{672c}\u{8a9e}".into()
            )])
        );
    }

    #[test]
    fn lexer_error_propagates_through_parse() {
        let d = err1("yah 1\nx = \"unterminated");
        assert_eq!(d.summary, "Unterminated string");
        assert_eq!((d.line, d.col), (2, 5));
    }

    #[test]
    fn unterminated_string_reports_opening_quote_and_following_statement_recovers() {
        // S5b(d): the string opened at (2,5) has no closing quote; the next
        // quote in the file is at (3,5). The single error must be at the
        // OPENING quote (2,5), not (3,5) or EOF, and the following
        // statement must still parse (no cascade, no extra errors).
        let d = err1("yah 1\nx = \"unterminated\ny = \"ok\"\n");
        assert_eq!(d.summary, "Unterminated string");
        assert_eq!((d.line, d.col), (2, 5));
    }

    #[test]
    fn unterminated_string_and_later_stray_at_report_exactly_two_errors() {
        // S5b(d): one unterminated string and one later stray '@' in one
        // file report BOTH errors, each exactly once: the unterminated
        // string at its opening quote and the '@' at its own position.
        let src = "yah 1\nx = \"unterminated\ny = \"ok\"\n@\n";
        let d = parse("test.yah", src).unwrap_err();
        assert_eq!(d.0.len(), 2, "{d:?}");
        assert_eq!(d.0[0].summary, "Unterminated string");
        assert_eq!((d.0[0].line, d.0[0].col), (2, 5));
        assert_eq!(d.0[1].summary, "Unexpected character");
        assert!(d.0[1].detail.contains('@'));
        assert_eq!((d.0[1].line, d.0[1].col), (4, 1));
    }

    #[test]
    fn three_syntax_errors_all_reported() {
        // One bad value at top level, one inside a block, one after the block:
        // recovery must report all three, not stop at the first.
        let src = "yah 1\na = = 1\nblk {\n  b = = 2\n  ok = 3\n}\nc = = 4\n";
        let d = parse("test.yah", src).unwrap_err();
        assert_eq!(d.0.len(), 3, "{d:?}");
        assert!(d.0.iter().all(|x| x.summary == "Expected value"), "{d:?}");
        assert_eq!(
            d.0.iter().map(|x| x.line).collect::<Vec<_>>(),
            vec![2, 4, 7]
        );
    }

    #[test]
    fn error_inside_nested_env_map_reports_exactly_once_and_recovers() {
        // The bad entry is inside a map inside a block: the map's `}` must be
        // consumed as the map's, the block's `}` must close the block, and the
        // following statement in the block must still parse — exactly 1 error.
        let src = "yah 1\nblk {\n  env = {\n    BAD = = 1\n  }\n  ok = 3\n}\n";
        let d = parse("test.yah", src).unwrap_err();
        assert_eq!(d.0.len(), 1, "{d:?}");
        assert_eq!(d.0[0].summary, "Expected value");
        assert_eq!(d.0[0].line, 4);
    }

    #[test]
    fn unterminated_interpolation_in_map_in_block_reports_exactly_one() {
        // Mini A-39: the interpolation error is inside a map inside two nested
        // blocks. Exactly the primary diagnostic — no cascade `Expected
        // statement` on either real closing brace, no `Unclosed block`.
        let src = "yah 1\nharness \"commander\" {\n  open {\n    env = {\n      FLEET_TOKEN = \"${vault.local.FLEET_TOKEN\"\n    }\n  }\n}\n";
        let d = parse("test.yah", src).unwrap_err();
        assert_eq!(d.0.len(), 1, "{d:?}");
        assert_eq!(d.0[0].summary, "Invalid interpolation");
    }

    #[test]
    fn missing_value_after_equals_reports_exactly_once_and_recovers() {
        // `a =` immediately before the block's `}`: exactly 1 `Expected value`,
        // the `}` still closes the block, the next block still parses.
        let src = "yah 1\nblk {\n  a =\n}\nnext {\n  b = 2\n}\n";
        let d = parse("test.yah", src).unwrap_err();
        assert_eq!(d.0.len(), 1, "{d:?}");
        assert_eq!(d.0[0].summary, "Expected value");
        assert_eq!(d.0[0].line, 4);
    }

    #[test]
    fn truncations_of_flat_source_never_exceed_broken_statements_plus_one() {
        // Every prefix of this flat source breaks at most one distinct
        // statement, so a parse may report at most 1 + 1 diagnostics — and
        // must never panic.
        let src = "yah 1\na = 1\nb = [1, 2]\nc = \"x\"\nd = { k = 1 }\ne = true\n";
        for (i, _) in src.char_indices() {
            if let Err(d) = parse("test.yah", &src[..i]) {
                assert!(
                    d.0.len() <= 2,
                    "prefix {i}: {} diagnostics: {d:?}",
                    d.0.len()
                );
            }
        }
        let _ = parse("test.yah", src).unwrap();
    }

    #[test]
    fn recovery_is_capped_at_20_errors() {
        let mut src = String::from("yah 1\n");
        for i in 0..25 {
            src.push_str(&format!("k{i} = = {i}\n"));
        }
        let d = parse("test.yah", &src).unwrap_err();
        assert_eq!(d.0.len(), 20, "{d:?}");
    }

    #[test]
    fn truncations_never_panic() {
        let src = include_str!("../../tests/fixtures/canonical.yah");
        for (i, _) in src.char_indices() {
            let _ = parse("test.yah", &src[..i]);
        }
        let _ = parse("test.yah", src);
    }

    #[test]
    fn list_missing_bracket_before_block_braces_reports_exactly_once() {
        // Commander's S5b(c) case: the list in `open` is never closed and
        // the next tokens are the `}` of `open` and the `}` of `harness`.
        // Exactly 1 error — the list error — and no false `Unclosed block`
        // for either enclosing block: both braces close their blocks.
        let src = "yah 1\nprovider \"anthropic\" {\n  type = \"anthropic\"\n}\nharness \"commander\" {\n  open {\n    command = [\"cat\"\n  }\n}\n";
        let d = parse("test.yah", src).unwrap_err();
        assert_eq!(d.0.len(), 1, "{d:?}");
        assert_eq!(d.0[0].summary, "Expected \",\" or \"]\"");
    }

    #[test]
    fn unclosed_block_after_error_reports_no_duplicate() {
        // The value error already ends at EOF; no extra "Unclosed block".
        let d = err1("yah 1\nblk {\n  b = [1,\n");
        assert_eq!(d.summary, "Unclosed list");
    }

    #[test]
    fn assignment_and_block_spans() {
        let f = ok("yah 1\n  x = 1\n  open { }");
        match &f.stmts[0] {
            Stmt::Assign(a) => assert_eq!((a.span.line, a.span.col), (2, 3)),
            _ => panic!(),
        }
        match &f.stmts[1] {
            Stmt::Block(b) => assert_eq!((b.span.line, b.span.col), (3, 3)),
            _ => panic!(),
        }
    }
}

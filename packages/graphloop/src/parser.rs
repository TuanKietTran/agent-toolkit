//! Recursive-descent parser. OWNER: gl-syntax.

use crate::ast::{self, Expr, ExprKind, Span, StrPart};
use crate::diag::{Diagnostic, Diagnostics};
use crate::lexer::{self, Tok, Token};

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
    let mut i = 0usize;
    while i < chars.len() {
        let c = chars[i];
        if c == '$' && i + 1 < chars.len() && chars[i + 1] == '{' {
            let dollar_span = Span { line, col };
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
                return Err(err(file, dollar_span, "Invalid interpolation", "Unterminated interpolation: '${' has no closing '}'."));
            }
            let inner: String = chars[i + 2..j].iter().collect();
            let trimmed = inner.trim();
            if trimmed.is_empty() {
                return Err(err(file, dollar_span, "Invalid interpolation", "Invalid interpolation: '${}' is empty."));
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
                return Err(err(file, dollar_span, "Invalid interpolation", format!("Invalid interpolation '${{{inner}}}': expected a dotted reference path.")));
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
                i += 1;
            }
        } else {
            lit.push(c);
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

struct Parser {
    tokens: Vec<Token>,
    pos: usize,
    file: String,
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

    fn parse_statements_until_brace(&mut self, opener: Span) -> Result<Vec<ast::Stmt>, Diagnostics> {
        let mut body = Vec::new();
        loop {
            match self.peek() {
                Tok::RBrace => {
                    self.bump();
                    break;
                }
                Tok::Eof => {
                    return Err(self.error(opener, "Unclosed block", "The block starting here is not closed."));
                }
                _ => body.push(self.parse_statement()?),
            }
        }
        Ok(body)
    }

    fn parse_block_body(&mut self) -> Result<Vec<ast::Stmt>, Diagnostics> {
        // Caller has verified the peek is '{'.
        let opener = self.peek_span();
        self.bump();
        self.parse_statements_until_brace(opener)
    }

    fn parse_statement(&mut self) -> Result<ast::Stmt, Diagnostics> {
        let start_span = self.peek_span();
        let Tok::Ident(kind) = self.peek().clone() else {
            return Err(self.error(start_span, "Expected statement", "Expected a block or an assignment."));
        };
        let ident_span = start_span;
        self.bump();
        match self.peek().clone() {
            Tok::Eq => {
                self.bump();
                let value = self.parse_value()?;
                Ok(ast::Stmt::Assign(ast::Assign { key: kind, value, span: ident_span }))
            }
            Tok::LBrace => {
                let body = self.parse_block_body()?;
                Ok(ast::Stmt::Block(ast::Block { kind, label: None, body, span: ident_span }))
            }
            Tok::Str(label) => {
                self.bump();
                if *self.peek() != Tok::LBrace {
                    let span = self.peek_span();
                    return Err(self.error(span, "Expected \"=\" or \"{\"", "Expected \"{\" after a block label."));
                }
                let body = self.parse_block_body()?;
                Ok(ast::Stmt::Block(ast::Block { kind, label: Some(label), body, span: ident_span }))
            }
            _ => {
                let span = self.peek_span();
                Err(self.error(span, "Expected \"=\" or \"{\"", "Expected \"=\" or \"{\" after an identifier."))
            }
        }
    }

    fn parse_value(&mut self) -> Result<Expr, Diagnostics> {
        let span = self.peek_span();
        match self.peek().clone() {
            Tok::Str(text) => {
                self.bump();
                let parts = split_string(&self.file, &text, span)?;
                Ok(Expr { kind: ExprKind::Str(parts), span })
            }
            Tok::Raw(text) => {
                self.bump();
                Ok(Expr { kind: ExprKind::Str(vec![StrPart::Lit(text)]), span })
            }
            Tok::Num(n) => {
                self.bump();
                Ok(Expr { kind: ExprKind::Num(n), span })
            }
            Tok::Ident(first) => {
                self.bump();
                if *self.peek() != Tok::Dot {
                    match first.as_str() {
                        "true" => return Ok(Expr { kind: ExprKind::Bool(true), span }),
                        "false" => return Ok(Expr { kind: ExprKind::Bool(false), span }),
                        "null" => return Ok(Expr { kind: ExprKind::Null, span }),
                        _ => {}
                    }
                }
                let mut segments = vec![first];
                while *self.peek() == Tok::Dot {
                    self.bump();
                    let seg_span = self.peek_span();
                    let Tok::Ident(seg) = self.peek().clone() else {
                        return Err(self.error(seg_span, "Expected identifier", "Expected an identifier after '.'."));
                    };
                    self.bump();
                    segments.push(seg);
                }
                Ok(Expr { kind: ExprKind::Ref(segments), span })
            }
            Tok::LBracket => {
                self.bump();
                let mut items = Vec::new();
                loop {
                    match self.peek() {
                        Tok::RBracket => {
                            self.bump();
                            break;
                        }
                        Tok::Eof => {
                            return Err(self.error(span, "Unclosed list", "The list starting here is not closed."));
                        }
                        _ => {}
                    }
                    items.push(self.parse_value()?);
                    match self.peek() {
                        Tok::Comma => {
                            self.bump();
                        }
                        Tok::RBracket => {}
                        Tok::Eof => {
                            return Err(self.error(span, "Unclosed list", "The list starting here is not closed."));
                        }
                        _ => {
                            let s = self.peek_span();
                            return Err(self.error(s, "Expected \",\" or \"]\"", "Expected \",\" or \"]\" in a list."));
                        }
                    }
                }
                Ok(Expr { kind: ExprKind::List(items), span })
            }
            Tok::LBrace => {
                self.bump();
                let mut entries = Vec::new();
                loop {
                    match self.peek() {
                        Tok::RBrace => {
                            self.bump();
                            break;
                        }
                        Tok::Eof => {
                            return Err(self.error(span, "Unclosed map", "The map starting here is not closed."));
                        }
                        _ => {}
                    }
                    let key_span = self.peek_span();
                    let Tok::Ident(key) = self.peek().clone() else {
                        return Err(self.error(key_span, "Expected identifier", "Expected a key in a map."));
                    };
                    self.bump();
                    if *self.peek() != Tok::Eq {
                        let s = self.peek_span();
                        return Err(self.error(s, "Expected \"=\"", "Expected \"=\" after a map key."));
                    }
                    self.bump();
                    let value = self.parse_value()?;
                    entries.push(ast::Assign { key, value, span: key_span });
                    if *self.peek() == Tok::Comma {
                        self.bump();
                    }
                }
                Ok(Expr { kind: ExprKind::Map(entries), span })
            }
            _ => Err(self.error(span, "Expected value", "Expected a value.")),
        }
    }
}

/// Lex and parse `src`. Checks the `yah N` header (N must be 1 in this version) and the grammar.
/// Stops at the first error, reported with `file:line:col`. Does NOT check which blocks or keys
/// are allowed (that is `schema`), nor top-level assignments (also `schema`).
pub fn parse(file: &str, src: &str) -> Result<ast::File, Diagnostics> {
    let tokens = lexer::lex(file, src)?;
    // Header: Ident("yah") then Num(1).
    let first = tokens.first().cloned().unwrap_or(Token { tok: Tok::Eof, span: Span { line: 1, col: 1 } });
    if first.tok != Tok::Ident("yah".to_string()) {
        return Err(err(file, first.span, "Missing or unsupported header", HEADER_DETAIL));
    }
    let second = tokens.get(1).cloned().unwrap_or(Token { tok: Tok::Eof, span: first.span });
    let Tok::Num(version_num) = second.tok else {
        return Err(err(file, second.span, "Missing or unsupported header", HEADER_DETAIL));
    };
    if version_num.fract() != 0.0 {
        return Err(err(file, second.span, "Missing or unsupported header", HEADER_DETAIL));
    }
    if version_num != 1.0 {
        return Err(err(file, second.span, "Unsupported version", format!("Unsupported version {}; only version 1 is supported.", version_num as i64)));
    }
    let mut parser = Parser { tokens, pos: 2, file: file.to_string() };
    let mut stmts = Vec::new();
    while *parser.peek() != Tok::Eof {
        stmts.push(parser.parse_statement()?);
    }
    Ok(ast::File { name: file.to_string(), version: 1, stmts })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ast::{Stmt, StrPart};

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
        let src = include_str!("../tests/fixtures/canonical.yah");
        let f = ok(src);
        assert_eq!(f.version, 1);
        assert_eq!(f.name, "test.yah");
        let kinds: Vec<&str> = f.stmts.iter().map(|s| match s { Stmt::Block(b) => b.kind.as_str(), Stmt::Assign(_) => "<assign>" }).collect();
        assert_eq!(kinds, vec!["variable", "defaults", "provider", "model", "system_one", "api", "harness", "harness", "team"]);
        let labels: Vec<Option<&str>> = f.stmts.iter().map(|s| match s { Stmt::Block(b) => b.label.as_deref(), _ => None }).collect();
        assert_eq!(labels[0], Some("work_dir"));
        assert_eq!(labels[1], None);
        assert_eq!(labels[2], Some("anthropic"));
        assert_eq!(labels[7], Some("builder"));
    }

    #[test]
    fn canonical_refs_lists_and_nested_open() {
        let src = include_str!("../tests/fixtures/canonical.yah");
        let f = ok(src);
        // provider api_key = env.ANTHROPIC_API_KEY
        let provider = match &f.stmts[2] { Stmt::Block(b) => b, _ => panic!() };
        assert_eq!(provider.assign("api_key").unwrap().value.kind, ExprKind::Ref(vec!["env".into(), "ANTHROPIC_API_KEY".into()]));
        // api command list, last item is a ref
        let api = match &f.stmts[5] { Stmt::Block(b) => b, _ => panic!() };
        let ExprKind::List(items) = &api.assign("command").unwrap().value.kind else { panic!() };
        assert_eq!(items.len(), 4);
        assert_eq!(items[3].kind, ExprKind::Ref(vec!["var".into(), "work_dir".into()]));
        // harness commander nested open block
        let commander = match &f.stmts[6] { Stmt::Block(b) => b, _ => panic!() };
        let open = commander.block("open").unwrap();
        assert_eq!(open.label, None);
        assert_eq!(open.assign("cols").unwrap().value.kind, ExprKind::Num(140.0));
        assert_eq!(open.assign("rows").unwrap().value.kind, ExprKind::Num(40.0));
        // builder open cwd = var.work_dir
        let builder = match &f.stmts[7] { Stmt::Block(b) => b, _ => panic!() };
        assert_eq!(builder.block("open").unwrap().assign("cwd").unwrap().value.kind, ExprKind::Ref(vec!["var".into(), "work_dir".into()]));
        // team graph = true
        let team = match &f.stmts[8] { Stmt::Block(b) => b, _ => panic!() };
        assert_eq!(team.assign("graph").unwrap().value.kind, ExprKind::Bool(true));
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
        assert_eq!(d.detail, "The first non-comment line of a .yah file must be \"yah 1\".");
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
        let kinds: Vec<ExprKind> = f.stmts.iter().map(|s| match s { Stmt::Assign(a) => a.value.kind.clone(), _ => panic!() }).collect();
        assert_eq!(kinds, vec![ExprKind::Bool(true), ExprKind::Bool(false), ExprKind::Null, ExprKind::Num(-2.5), ExprKind::Str(vec![StrPart::Lit("hi".into())])]);
    }

    #[test]
    fn dotted_ref_values() {
        let f = ok("yah 1\nx = harnesses.builder.model");
        assert_eq!(first_assign(&f).value.kind, ExprKind::Ref(vec!["harnesses".into(), "builder".into(), "model".into()]));
    }

    #[test]
    fn empty_string_is_empty_parts() {
        let f = ok("yah 1\nx = \"\"");
        assert_eq!(first_assign(&f).value.kind, ExprKind::Str(vec![]));
    }

    #[test]
    fn raw_string_is_single_lit_no_interpolation() {
        let f = ok("yah 1\nx = `${var.x} and $`");
        assert_eq!(first_assign(&f).value.kind, ExprKind::Str(vec![StrPart::Lit("${var.x} and $".into())]));
    }

    #[test]
    fn empty_raw_is_single_empty_lit() {
        let f = ok("yah 1\nx = ``");
        assert_eq!(first_assign(&f).value.kind, ExprKind::Str(vec![StrPart::Lit(String::new())]));
    }

    #[test]
    fn interpolation_parts_and_span() {
        let f = ok("yah 1\nx = \"${env.A}-${var.b}\"");
        let ExprKind::Str(parts) = &first_assign(&f).value.kind else { panic!() };
        assert_eq!(parts.len(), 3);
        assert_eq!(parts[0], StrPart::Interp(vec!["env".into(), "A".into()], Span { line: 2, col: 6 }));
        assert_eq!(parts[1], StrPart::Lit("-".into()));
        assert_eq!(parts[2], StrPart::Interp(vec!["var".into(), "b".into()], Span { line: 2, col: 15 }));
    }

    #[test]
    fn interpolation_with_spaces() {
        let f = ok("yah 1\nx = \"a ${ var.x } b\"");
        let ExprKind::Str(parts) = &first_assign(&f).value.kind else { panic!() };
        assert_eq!(parts, &vec![StrPart::Lit("a ".into()), StrPart::Interp(vec!["var".into(), "x".into()], Span { line: 2, col: 8 }), StrPart::Lit(" b".into())]);
    }

    #[test]
    fn multiline_string_interpolation_span() {
        let f = ok("yah 1\nx = \"line1\nline2 ${var.x} end\"");
        let ExprKind::Str(parts) = &first_assign(&f).value.kind else { panic!() };
        assert_eq!(parts.len(), 3);
        assert_eq!(parts[0], StrPart::Lit("line1\nline2 ".into()));
        assert_eq!(parts[1], StrPart::Interp(vec!["var".into(), "x".into()], Span { line: 3, col: 7 }));
        assert_eq!(parts[2], StrPart::Lit(" end".into()));
    }

    #[test]
    fn dollar_not_followed_by_brace_is_literal() {
        let f = ok("yah 1\nx = \"cost $5 and $x\"");
        assert_eq!(first_assign(&f).value.kind, ExprKind::Str(vec![StrPart::Lit("cost $5 and $x".into())]));
    }

    #[test]
    fn invalid_interpolation_unterminated() {
        let d = err1("yah 1\nx = \"${var.x\"");
        assert_eq!(d.summary, "Invalid interpolation");
        assert_eq!((d.line, d.col), (2, 6));
    }

    #[test]
    fn invalid_interpolation_malformed() {
        for src in ["yah 1\nx = \"${}\"", "yah 1\nx = \"${123}\"", "yah 1\nx = \"${var..x}\"", "yah 1\nx = \"${var.}\"", "yah 1\nx = \"${.var}\""] {
            let d = err1(src);
            assert_eq!(d.summary, "Invalid interpolation", "src={src}");
            assert_eq!((d.line, d.col), (2, 6), "src={src}");
        }
    }

    #[test]
    fn lists_trailing_comma_and_ref_inside() {
        let f = ok("yah 1\nx = [1, \"a\", var.work_dir,]");
        let ExprKind::List(items) = &first_assign(&f).value.kind else { panic!() };
        assert_eq!(items.len(), 3);
        assert_eq!(items[2].kind, ExprKind::Ref(vec!["var".into(), "work_dir".into()]));
    }

    #[test]
    fn empty_list_and_empty_map() {
        let f = ok("yah 1\na = []\nb = {}");
        assert_eq!(match &f.stmts[0] { Stmt::Assign(a) => a.value.kind.clone(), _ => panic!() }, ExprKind::List(vec![]));
        assert_eq!(match &f.stmts[1] { Stmt::Assign(a) => a.value.kind.clone(), _ => panic!() }, ExprKind::Map(vec![]));
    }

    #[test]
    fn map_commas_optional_and_nested_map() {
        let f = ok("yah 1\nx = { a = 1 b = { c = 2, d = 3 } e = 4 }");
        let ExprKind::Map(entries) = &first_assign(&f).value.kind else { panic!() };
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0].key, "a");
        let ExprKind::Map(inner) = &entries[1].value.kind else { panic!() };
        assert_eq!(inner.len(), 2);
        assert_eq!(inner[1].key, "d");
    }

    #[test]
    fn comments_everywhere_and_trailing_commas() {
        let f = ok("// a\nyah 1 // b\n// c\nx = [ // d\n 1, // e\n 2, // f\n] // g");
        let ExprKind::List(items) = &first_assign(&f).value.kind else { panic!() };
        assert_eq!(items.len(), 2);
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
        assert_eq!(first_assign(&f).value.kind, ExprKind::Str(vec![StrPart::Lit("caf\u{e9} \u{2615} \u{65e5}\u{672c}\u{8a9e}".into())]));
    }

    #[test]
    fn lexer_error_propagates_through_parse() {
        let d = err1("yah 1\nx = \"unterminated");
        assert_eq!(d.summary, "Unterminated string");
        assert_eq!((d.line, d.col), (2, 5));
    }

    #[test]
    fn assignment_and_block_spans() {
        let f = ok("yah 1\n  x = 1\n  open { }");
        match &f.stmts[0] { Stmt::Assign(a) => assert_eq!((a.span.line, a.span.col), (2, 3)), _ => panic!() }
        match &f.stmts[1] { Stmt::Block(b) => assert_eq!((b.span.line, b.span.col), (3, 3)), _ => panic!() }
    }
}

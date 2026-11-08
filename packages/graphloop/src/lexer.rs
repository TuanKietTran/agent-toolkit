//! Tokens. OWNER: gl-syntax (lexer.rs and parser.rs).
//!
//! Rules (docs/graphspec.md): UTF-8; `//` comments to end of line; indentation insignificant;
//! identifiers `[a-zA-Z_][a-zA-Z0-9_-]*`; double-quoted strings `"[^"]*"` (may contain `${...}`,
//! may span lines, no escapes); raw backtick strings; numbers; `{ } [ ] = , .`.
//! The header is lexed as the identifier `yah` followed by a number.

use crate::ast::Span;
use crate::diag::{Diagnostic, Diagnostics};

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
    /// A `//` comment to end of line, kept as trivia for the parser to attach
    /// to a statement. The text includes the leading `//`, verbatim.
    Comment(String),
    /// A lexical error (unterminated string, unexpected character, invalid
    /// number). Lexing continued past it; the parser reports this diagnostic
    /// exactly once when it reaches the token.
    Error(Diagnostic),
}

#[derive(Debug, Clone, PartialEq)]
pub struct Token {
    pub tok: Tok,
    pub span: Span,
}

fn is_ident_start(c: char) -> bool {
    c.is_ascii_alphabetic() || c == '_'
}

fn is_ident_continue(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_' || c == '-'
}

struct Lexer {
    chars: Vec<char>,
    pos: usize,
    byte_pos: u32,
    line: u32,
    col: u32,
    file: String,
}

impl Lexer {
    fn span(&self) -> Span {
        Span { line: self.line, col: self.col, offset: self.byte_pos, len: 0 }
    }

    /// Fill in the byte length of a token that started at `start`, now fully consumed.
    fn end_span(&self, start: Span) -> Span {
        Span { len: self.byte_pos.saturating_sub(start.offset), ..start }
    }

    fn peek(&self) -> Option<char> {
        self.chars.get(self.pos).copied()
    }

    fn peek_at(&self, offset: usize) -> Option<char> {
        self.chars.get(self.pos + offset).copied()
    }

    fn bump(&mut self) -> Option<char> {
        let c = self.peek()?;
        self.pos += 1;
        self.byte_pos += c.len_utf8() as u32;
        if c == '\n' {
            self.line += 1;
            self.col = 1;
        } else {
            self.col += 1;
        }
        Some(c)
    }

    fn err(&self, span: Span, summary: &str, detail: String) -> Diagnostics {
        Diagnostics::one(Diagnostic::error(&self.file, span, summary, detail))
    }

    fn skip_ws(&mut self) {
        while matches!(self.peek(), Some(c) if c.is_whitespace()) {
            self.bump();
        }
    }

    /// Consume a `//` comment starting at the cursor (the caller has checked
    /// both slashes) up to but not including the newline.
    fn lex_comment(&mut self) -> Token {
        let start = self.span();
        let mut text = String::new();
        while let Some(c) = self.peek() {
            if c == '\n' {
                break;
            }
            text.push(c);
            self.bump();
        }
        Token { tok: Tok::Comment(text), span: self.end_span(start) }
    }

    fn lex_string(&mut self, quote: char) -> Token {
        let start = self.span();
        self.bump(); // opening quote
        let mut text = String::new();
        loop {
            match self.peek() {
                None => {
                    let d = self.err(start, "Unterminated string", "The string starting here is not terminated.".to_string());
                    return Token { tok: Tok::Error(d.0.into_iter().next().unwrap()), span: self.end_span(start) };
                }
                Some(c) if c == quote => {
                    self.bump();
                    break;
                }
                Some('\n') if quote == '"' && self.next_line_starts_statement() => {
                    // A statement starting on the next line means this string
                    // was never closed (its closing quote is that statement's
                    // string): report it at the OPENING quote and leave the
                    // newline unconsumed, so lexing resumes at the statement.
                    // Strings may span lines, but a continuation line never
                    // starts a statement.
                    let d = self.err(start, "Unterminated string", "The string starting here is not terminated.".to_string());
                    return Token { tok: Tok::Error(d.0.into_iter().next().unwrap()), span: Span { len: 1, ..start } };
                }
                Some(c) => {
                    text.push(c);
                    self.bump();
                }
            }
        }
        let tok = if quote == '`' { Tok::Raw(text) } else { Tok::Str(text) };
        Token { tok, span: self.end_span(start) }
    }

    /// Recovery lookahead for an unterminated double-quoted string: the
    /// cursor is on a `\n` inside the string; does the next line start a
    /// statement (`ident =`, `ident {`, `ident "..." {`)? Char-level, same
    /// line only; the cursor is not moved.
    fn next_line_starts_statement(&self) -> bool {
        let mut i = self.pos + 1; // skip the '\n' the cursor is on
        while matches!(self.chars.get(i), Some(' ' | '\t')) { i += 1; }
        let Some(&c0) = self.chars.get(i) else { return false };
        if !is_ident_start(c0) { return false; }
        while matches!(self.chars.get(i), Some(&c) if is_ident_continue(c)) { i += 1; }
        while matches!(self.chars.get(i), Some(' ' | '\t')) { i += 1; }
        match self.chars.get(i) {
            Some('=' | '{') => true,
            Some('"' | '`') => {
                let q = self.chars[i];
                i += 1;
                while matches!(self.chars.get(i), Some(&c) if c != q && c != '\n') { i += 1; }
                if self.chars.get(i) != Some(&q) { return false; }
                i += 1;
                while matches!(self.chars.get(i), Some(' ' | '\t')) { i += 1; }
                self.chars.get(i) == Some(&'{')
            }
            _ => false,
        }
    }

    fn lex_number(&mut self) -> Token {
        let start = self.span();
        let mut text = String::new();
        if self.peek() == Some('-') {
            text.push('-');
            self.bump();
        }
        while let Some(c) = self.peek() {
            if c.is_ascii_digit() {
                text.push(c);
                self.bump();
            } else {
                break;
            }
        }
        // Optional fraction, only when '.' is followed by a digit.
        if self.peek() == Some('.') && self.peek_at(1).is_some_and(|c| c.is_ascii_digit()) {
            text.push('.');
            self.bump();
            while let Some(c) = self.peek() {
                if c.is_ascii_digit() {
                    text.push(c);
                    self.bump();
                } else {
                    break;
                }
            }
        }
        // A number directly followed by identifier characters is invalid.
        if let Some(c) = self.peek()
            && (c.is_ascii_alphanumeric() || c == '_')
        {
            let mut bad = text.clone();
            while let Some(c) = self.peek() {
                if is_ident_continue(c) {
                    bad.push(c);
                    self.bump();
                } else {
                    break;
                }
            }
            let d = self.err(self.end_span(start), "Invalid number", format!("Invalid number '{bad}'."));
            return Token { tok: Tok::Error(d.0.into_iter().next().unwrap()), span: self.end_span(start) };
        }
        match text.parse::<f64>() {
            Ok(n) => Token { tok: Tok::Num(n), span: self.end_span(start) },
            Err(_) => {
                let d = self.err(self.end_span(start), "Invalid number", format!("Invalid number '{text}'."));
                Token { tok: Tok::Error(d.0.into_iter().next().unwrap()), span: self.end_span(start) }
            }
        }
    }

    fn lex_ident(&mut self) -> Token {
        let start = self.span();
        let mut text = String::new();
        while let Some(c) = self.peek() {
            if is_ident_continue(c) {
                text.push(c);
                self.bump();
            } else {
                break;
            }
        }
        Token { tok: Tok::Ident(text), span: self.end_span(start) }
    }
}

/// Tokenize `src`. Never fails: a bad token (unterminated string, stray
/// character, invalid number) becomes a `Tok::Error` carrying its diagnostic
/// and lexing continues, so later tokens are still produced.
pub fn lex(file: &str, src: &str) -> Vec<Token> {
    let mut lx = Lexer { chars: src.chars().collect(), pos: 0, byte_pos: 0, line: 1, col: 1, file: file.to_string() };
    let mut tokens = Vec::new();
    loop {
        lx.skip_ws();
        let span = lx.span();
        let Some(c) = lx.peek() else {
            tokens.push(Token { tok: Tok::Eof, span });
            break;
        };
        let token = match c {
            '/' if lx.peek_at(1) == Some('/') => lx.lex_comment(),
            '"' => lx.lex_string('"'),
            '`' => lx.lex_string('`'),
            '{' => { lx.bump(); Token { tok: Tok::LBrace, span: lx.end_span(span) } }
            '}' => { lx.bump(); Token { tok: Tok::RBrace, span: lx.end_span(span) } }
            '[' => { lx.bump(); Token { tok: Tok::LBracket, span: lx.end_span(span) } }
            ']' => { lx.bump(); Token { tok: Tok::RBracket, span: lx.end_span(span) } }
            '=' => { lx.bump(); Token { tok: Tok::Eq, span: lx.end_span(span) } }
            ',' => { lx.bump(); Token { tok: Tok::Comma, span: lx.end_span(span) } }
            '.' => { lx.bump(); Token { tok: Tok::Dot, span: lx.end_span(span) } }
            _ if c.is_ascii_digit() || (c == '-' && lx.peek_at(1).is_some_and(|n| n.is_ascii_digit())) => lx.lex_number(),
            _ if is_ident_start(c) => lx.lex_ident(),
            _ => {
                let d = lx.err(Span { len: c.len_utf8() as u32, ..span }, "Unexpected character", format!("Unexpected character '{c}'."));
                lx.bump();
                Token { tok: Tok::Error(d.0.into_iter().next().unwrap()), span: lx.end_span(span) }
            }
        };
        tokens.push(token);
    }
    tokens
}

#[cfg(test)]
mod tests {
    use super::*;

    fn toks(src: &str) -> Vec<Token> {
        lex("test.yah", src)
    }

    fn err(src: &str) -> Diagnostic {
        let errs: Vec<Diagnostic> = lex("test.yah", src).iter().filter_map(|t| match &t.tok { Tok::Error(d) => Some(d.clone()), _ => None }).collect();
        assert_eq!(errs.len(), 1, "{errs:?}");
        errs[0].clone()
    }

    #[test]
    fn token_spans_carry_byte_offset_and_len() {
        let t = toks("yah 1\nx = \"ab\"");
        assert_eq!((t[0].span.offset, t[0].span.len), (0, 3));
        assert_eq!((t[1].span.offset, t[1].span.len), (4, 1));
        let str_tok = t.iter().find(|t| matches!(t.tok, Tok::Str(_))).unwrap();
        assert_eq!((str_tok.span.offset, str_tok.span.len), (10, 4));
        // Byte offsets, not char counts: the two-byte 'é' makes the token 4 bytes.
        let t2 = toks("\"é\"");
        assert_eq!((t2[0].span.offset, t2[0].span.len), (0, 4));
    }

    #[test]
    fn empty_source_is_only_eof() {
        let t = toks("");
        assert_eq!(t.len(), 1);
        assert_eq!(t[0].tok, Tok::Eof);
        assert_eq!((t[0].span.line, t[0].span.col), (1, 1));
    }

    #[test]
    fn header_tokens_and_spans() {
        let t = toks("yah 1");
        assert_eq!(t[0].tok, Tok::Ident("yah".into()));
        assert_eq!((t[0].span.line, t[0].span.col), (1, 1));
        assert_eq!(t[1].tok, Tok::Num(1.0));
        assert_eq!((t[1].span.line, t[1].span.col), (1, 5));
        assert_eq!(t[2].tok, Tok::Eof);
        assert_eq!((t[2].span.line, t[2].span.col), (1, 6));
    }

    #[test]
    fn punctuation_tokens() {
        let t = toks("{ } [ ] = , .");
        let kinds: Vec<Tok> = t.into_iter().map(|x| x.tok).collect();
        assert_eq!(kinds, vec![Tok::LBrace, Tok::RBrace, Tok::LBracket, Tok::RBracket, Tok::Eq, Tok::Comma, Tok::Dot, Tok::Eof]);
    }

    #[test]
    fn identifiers_with_hyphen_and_underscore() {
        let t = toks("my-key _x a1 ANTHROPIC_API_KEY");
        assert_eq!(t[0].tok, Tok::Ident("my-key".into()));
        assert_eq!(t[1].tok, Tok::Ident("_x".into()));
        assert_eq!(t[2].tok, Tok::Ident("a1".into()));
        assert_eq!(t[3].tok, Tok::Ident("ANTHROPIC_API_KEY".into()));
    }

    #[test]
    fn comments_are_kept_as_tokens_in_place() {
        let t = toks("// lead\nyah // mid\n1 // tail");
        assert_eq!(t[0].tok, Tok::Comment("// lead".into()));
        assert_eq!((t[0].span.line, t[0].span.col), (1, 1));
        assert_eq!(t[1].tok, Tok::Ident("yah".into()));
        assert_eq!((t[1].span.line, t[1].span.col), (2, 1));
        assert_eq!(t[2].tok, Tok::Comment("// mid".into()));
        assert_eq!((t[2].span.line, t[2].span.col), (2, 5));
        assert_eq!(t[3].tok, Tok::Num(1.0));
        assert_eq!((t[3].span.line, t[3].span.col), (3, 1));
        assert_eq!(t[4].tok, Tok::Comment("// tail".into()));
    }

    #[test]
    fn numbers_int_decimal_negative() {
        let t = toks("42 -7 3.25 -0.5 0");
        assert_eq!(t[0].tok, Tok::Num(42.0));
        assert_eq!(t[1].tok, Tok::Num(-7.0));
        assert_eq!(t[2].tok, Tok::Num(3.25));
        assert_eq!(t[3].tok, Tok::Num(-0.5));
        assert_eq!(t[4].tok, Tok::Num(0.0));
    }

    #[test]
    fn invalid_number_followed_by_letters() {
        let d = err("yah 1\nx = 12abc");
        assert_eq!(d.summary, "Invalid number");
        assert_eq!((d.line, d.col), (2, 5));
        assert!(d.detail.contains("12abc"));
    }

    #[test]
    fn invalid_number_decimal_followed_by_letters() {
        let d = err("1.5x");
        assert_eq!(d.summary, "Invalid number");
        assert_eq!((d.line, d.col), (1, 1));
    }

    #[test]
    fn strings_verbatim_and_multiline() {
        let t = toks("\"a\n b $x \" `raw ${var.x}`");
        assert_eq!(t[0].tok, Tok::Str("a\n b $x ".into()));
        assert_eq!(t[1].tok, Tok::Raw("raw ${var.x}".into()));
        // Raw token starts on line 2: ' b $x ' is 6 chars after the opening quote line.
        assert_eq!(t[1].span.line, 2);
    }

    #[test]
    fn unterminated_string_points_at_opening_quote() {
        let d = err("yah 1\nx = \"abc");
        assert_eq!(d.summary, "Unterminated string");
        assert_eq!((d.line, d.col), (2, 5));
    }

    #[test]
    fn unterminated_raw_points_at_opening_backtick() {
        let d = err("`abc");
        assert_eq!(d.summary, "Unterminated string");
        assert_eq!((d.line, d.col), (1, 1));
    }

    #[test]
    fn unexpected_character_names_it() {
        let d = err("yah 1\n@");
        assert_eq!(d.summary, "Unexpected character");
        assert_eq!((d.line, d.col), (2, 1));
        assert!(d.detail.contains('@'));
    }

    #[test]
    fn single_slash_is_unexpected() {
        let d = err("/ not-a-comment");
        assert_eq!(d.summary, "Unexpected character");
        assert!(d.detail.contains('/'));
    }

    #[test]
    fn bad_char_becomes_error_token_and_lexing_continues() {
        // S5b(d): a stray character is an Error token, not an abort — the
        // tokens after it are still produced.
        let t = toks("@ x = 1");
        assert!(matches!(t[0].tok, Tok::Error(_)));
        assert_eq!(t[1].tok, Tok::Ident("x".into()));
        assert_eq!(t[2].tok, Tok::Eq);
        assert_eq!(t[3].tok, Tok::Num(1.0));
        assert_eq!(t[4].tok, Tok::Eof);
    }

    #[test]
    fn lone_minus_is_unexpected() {
        let d = err("- x");
        assert_eq!(d.summary, "Unexpected character");
        assert_eq!((d.line, d.col), (1, 1));
    }

    #[test]
    fn crlf_line_endings() {
        let t = toks("yah 1\r\nx = 2");
        assert_eq!(t[2].tok, Tok::Ident("x".into()));
        assert_eq!((t[2].span.line, t[2].span.col), (2, 1));
        assert_eq!(t[4].tok, Tok::Num(2.0));
        assert_eq!((t[4].span.line, t[4].span.col), (2, 5));
    }

    #[test]
    fn columns_count_characters_not_bytes() {
        // 'é' is 2 bytes but 1 column.
        let t = toks("\"\u{e9}\" y");
        assert_eq!(t[0].tok, Tok::Str("\u{e9}".into()));
        assert_eq!(t[1].tok, Tok::Ident("y".into()));
        assert_eq!((t[1].span.line, t[1].span.col), (1, 5));
    }

    #[test]
    fn non_ascii_in_comment_does_not_shift_next_line() {
        let t = toks("// caf\u{e9} \u{2615}\nyah 1");
        assert_eq!(t[0].tok, Tok::Comment("// caf\u{e9} \u{2615}".into()));
        assert_eq!((t[0].span.line, t[0].span.col), (1, 1));
        assert_eq!(t[1].tok, Tok::Ident("yah".into()));
        assert_eq!(t[1].span.line, 2);
        assert_eq!(t[1].span.col, 1);
    }

    #[test]
    fn number_then_dot_without_digit_is_ref_like() {
        // `1.` lexes as Num(1) then Dot, since a fraction needs digits.
        let t = toks("1.");
        assert_eq!(t[0].tok, Tok::Num(1.0));
        assert_eq!(t[1].tok, Tok::Dot);
    }

    #[test]
    fn canonical_fixture_lexes_to_eof() {
        let src = include_str!("../tests/fixtures/canonical.yah");
        let t = toks(src);
        assert_eq!(t.last().unwrap().tok, Tok::Eof);
        assert!(t.len() > 50);
    }
}

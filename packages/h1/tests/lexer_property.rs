//! Lexer robustness properties: generated and truncated inputs must never
//! panic the front end, every token span and diagnostic must lie inside
//! the source, and an unterminated string or interpolation must be
//! reported at its opening position.
//!
//! Deterministic, std only: a fixed-seed xorshift64 generator builds the
//! synthetic inputs, and truncations walk every character boundary of the
//! valid corpus sources (byte offsets that split a multi-byte character
//! are not valid `&str` inputs and are skipped).

use std::panic::{AssertUnwindSafe, catch_unwind};

use h1::yah::ast::{ExprKind, Stmt, StrPart};
use h1::yah::diag::Diagnostic;
use h1::yah::lexer::{Tok, Token, lex};
use h1::yah::parser::parse;

const SEED: u64 = 0x2545_F491_4F6C_DD1D;

struct Rng(u64);

impl Rng {
    fn next_u64(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next_u64() % n as u64) as usize
    }
}

fn sources() -> Vec<(&'static str, &'static str)> {
    vec![
        ("canonical.yah", include_str!("fixtures/canonical.yah")),
        ("demo.yah", include_str!("../examples/demo.yah")),
        ("team.yah", include_str!("../examples/team.yah")),
        (
            "research-team.yah",
            include_str!("../examples/research-team.yah"),
        ),
        ("vault.yah", include_str!("../examples/vault.yah")),
    ]
}

/// 1-based line and column of the character at `offset` in `src`,
/// computed independently of the lexer (columns count characters).
fn line_col_at(src: &str, offset: usize) -> (u32, u32) {
    let mut line = 1u32;
    let mut col = 1u32;
    for c in src[..offset].chars() {
        if c == '\n' {
            line += 1;
            col = 1;
        } else {
            col += 1;
        }
    }
    (line, col)
}

fn check_token_spans(src: &str, tokens: &[Token]) {
    assert!(
        !tokens.is_empty(),
        "lexing always yields at least an end-of-input token"
    );
    assert_eq!(
        tokens.last().unwrap().tok,
        Tok::Eof,
        "last token must be end of input: src={src:?}"
    );
    let mut previous_offset = 0usize;
    for token in tokens {
        let offset = token.span.offset as usize;
        let end = offset + token.span.len as usize;
        assert!(
            offset <= src.len(),
            "token offset {offset} past end {}: src={src:?}",
            src.len()
        );
        assert!(
            end <= src.len(),
            "token end {end} past end {}: src={src:?}",
            src.len()
        );
        assert!(
            src.is_char_boundary(offset),
            "token offset {offset} splits a character: src={src:?}"
        );
        assert!(
            src.is_char_boundary(end),
            "token end {end} splits a character: src={src:?}"
        );
        assert!(
            offset >= previous_offset,
            "token offsets must not go backwards: src={src:?}"
        );
        previous_offset = offset;
        let (line, col) = line_col_at(src, offset);
        assert_eq!(
            (token.span.line, token.span.col),
            (line, col),
            "token line/col must match its byte offset: src={src:?}"
        );
        if let Tok::Error(d) = &token.tok {
            assert_eq!(
                (d.line, d.col),
                (line, col),
                "error diagnostic must sit on its token: src={src:?}"
            );
        }
    }
}

fn check_diagnostic_bounds(src: &str, d: &Diagnostic) {
    let lines: Vec<&str> = src.split('\n').collect();
    assert!(
        d.line >= 1,
        "diagnostic line must be 1-based: {d:?} src={src:?}"
    );
    assert!(
        (d.line as usize) <= lines.len(),
        "diagnostic line {} past last line {}: src={src:?}",
        d.line,
        lines.len()
    );
    assert!(
        d.col >= 1,
        "diagnostic column must be 1-based: {d:?} src={src:?}"
    );
    let line_text = lines[(d.line - 1) as usize];
    let line_chars = line_text.chars().count();
    assert!(
        (d.col as usize) <= line_chars + 1,
        "diagnostic column {} past line length {line_chars}: src={src:?}",
        d.col
    );
}

/// Lex and parse one input, checking every span and diagnostic produced.
/// A panic in either stage fails the calling test with the input named.
fn check_input(label: &str, src: &str) {
    let result = catch_unwind(AssertUnwindSafe(|| {
        let tokens = lex("test.yah", src);
        check_token_spans(src, &tokens);
        if let Err(diags) = parse("test.yah", src) {
            assert!(!diags.0.is_empty(), "a failed parse must carry diagnostics");
            for d in &diags.0 {
                check_diagnostic_bounds(src, d);
            }
        }
    }));
    assert!(
        result.is_ok(),
        "front end panicked or asserted on {label}: src={src:?}"
    );
}

#[test]
fn truncations_at_every_character_boundary() {
    let mut count = 0usize;
    let mut skipped_byte_cuts = 0usize;
    for (name, src) in sources() {
        for cut in 0..=src.len() {
            if !src.is_char_boundary(cut) {
                skipped_byte_cuts += 1;
                continue;
            }
            check_input(&format!("truncate:{name}@{cut}"), &src[..cut]);
            count += 1;
        }
    }
    assert!(count >= 1000, "corpus too small: {count} truncations");
    println!("truncations: {count} inputs, {skipped_byte_cuts} non-boundary byte cuts skipped");
}

#[test]
fn generated_fragment_inputs_never_panic() {
    let fragments: &[&str] = &[
        "yah 1\n",
        "x = ",
        "key",
        "\"",
        "`",
        "${",
        "}",
        "]",
        "[",
        "{",
        "=",
        ",",
        ".",
        "\n",
        " ",
        "\"abc\"",
        "`raw`",
        "1.5",
        "-3",
        "@",
        "#",
        "// note\n",
        "env.A",
        "var.x",
        "\u{e9}",
        "\u{2615}",
        "\u{1f30d}",
        "\u{4e2d}\u{6587}",
        "\"a ${env.A} b\"",
        "team {\n",
        "\"${}\"",
        "1..2",
        "//",
        "/",
        "\\",
        "'",
    ];
    let mut rng = Rng(SEED);
    for case in 0..600 {
        let parts = 1 + rng.below(14);
        let mut src = String::new();
        for _ in 0..parts {
            src.push_str(fragments[rng.below(fragments.len())]);
        }
        check_input(&format!("generated:{case}"), &src);
    }
}

#[test]
fn unicode_content_has_byte_correct_spans() {
    // Multi-byte characters inside a string: the string token covers the
    // opening quote through the closing quote in bytes, not characters.
    let src = "yah 1\nx = \"h\u{e9}llo \u{1f30d}\"\n";
    check_input("unicode string", src);
    let tokens = lex("test.yah", src);
    let string = tokens
        .iter()
        .find(|t| matches!(t.tok, Tok::Str(_)))
        .unwrap();
    let opening = src.find('\"').unwrap();
    assert_eq!(string.span.offset as usize, opening);
    assert_eq!(string.span.len as usize, "\"h\u{e9}llo \u{1f30d}\"".len());

    // An interpolation inside a string with multi-byte text before it:
    // the interpolation span is the byte offset of the `${...}`.
    let src = "yah 1\nx = \"caf\u{e9} ${env.A} \u{2615}\"\n";
    let file = parse("test.yah", src).expect("unicode interpolation parses");
    let Stmt::Assign(assign) = &file.stmts[0] else {
        panic!("expected assignment")
    };
    let ExprKind::Str(parts) = &assign.value.kind else {
        panic!("expected string value")
    };
    let interp = parts
        .iter()
        .find_map(|p| match p {
            StrPart::Interp(_, span) => Some(span),
            _ => None,
        })
        .unwrap();
    assert_eq!(interp.offset as usize, src.find("${env.A}").unwrap());
    assert_eq!(interp.len as usize, "${env.A}".len());

    // A multi-byte character outside a string is one unexpected-character
    // error covering its full byte length, reported by the parser once.
    let src = "yah 1\nx = \u{e9}\n";
    check_input("bare unicode", src);
    let tokens = lex("test.yah", src);
    let error = tokens
        .iter()
        .find_map(|t| match &t.tok {
            Tok::Error(d) => Some((t, d)),
            _ => None,
        })
        .unwrap();
    assert_eq!(error.1.summary, "Unexpected character");
    assert_eq!(error.0.span.offset as usize, src.find('\u{e9}').unwrap());
    assert_eq!(error.0.span.len as usize, '\u{e9}'.len_utf8());
    let diags = parse("test.yah", src).unwrap_err();
    assert!(
        diags.0.iter().any(|d| d.summary == "Unexpected character"
            && (d.line, d.col) == (error.1.line, error.1.col))
    );

    // Truncating a multi-byte source at character boundaries only.
    let src = "yah 1\n// caf\u{e9} \u{2615}\nx = \"\u{4e2d}\u{6587} \u{1f30d}\"\n";
    let mut cuts = 0usize;
    for cut in 0..=src.len() {
        if src.is_char_boundary(cut) {
            check_input(&format!("unicode truncate@{cut}"), &src[..cut]);
            cuts += 1;
        }
    }
    assert!(
        cuts < src.len(),
        "some byte cuts must have been skipped as non-boundaries"
    );
}

#[test]
fn stray_closers_are_errors_with_in_bounds_spans() {
    let cases: &[&str] = &[
        "}",
        "]",
        "}}",
        "]]",
        "} ] } ]",
        "])}}])",
        "yah 1\n}\n",
        "yah 1\n]\n",
        "yah 1\nx = ]\n",
        "yah 1\nx = }\n",
        "yah 1\nteam {\n]\n}\n",
        "yah 1\nx = [1, 2}\n",
        "yah 1\nx = { a = 1 ]\n",
    ];
    for src in cases {
        check_input("stray closer", src);
        assert!(
            parse("test.yah", src).is_err(),
            "a stray closer must not parse successfully: src={src:?}"
        );
    }
}

#[test]
fn unterminated_strings_are_reported_at_the_opening_quote() {
    let cases: &[&str] = &[
        "yah 1\nx = \"abc",
        "yah 1\nx = \"abc\ny = \"ok\"\n",
        "yah 1\nx = \"",
        "yah 1\nx = `abc",
        "yah 1\nx = `abc\ny = 2\n",
        "yah 1\nx = \"caf\u{e9} \u{2615}",
    ];
    for src in cases {
        check_input("unterminated string", src);
        let opening = src.find(['\"', '`']).unwrap();
        let (line, col) = line_col_at(src, opening);
        let tokens = lex("test.yah", src);
        let error = tokens.iter().find_map(|t| match &t.tok {
            Tok::Error(d) if d.summary == "Unterminated string" => Some((t, d)),
            _ => None,
        });
        let (token, diag) = error
            .unwrap_or_else(|| panic!("expected an unterminated-string error token: src={src:?}"));
        assert_eq!(
            token.span.offset as usize, opening,
            "error token must start at the opening quote: src={src:?}"
        );
        assert_eq!(
            (diag.line, diag.col),
            (line, col),
            "diagnostic must point at the opening quote: src={src:?}"
        );
        let diags = parse("test.yah", src).unwrap_err();
        assert!(
            diags
                .0
                .iter()
                .any(|d| d.summary == "Unterminated string" && (d.line, d.col) == (line, col)),
            "parse must report the unterminated string at its opening: src={src:?} diags={diags:?}"
        );
    }
}

#[test]
fn unterminated_interpolations_are_reported_at_the_dollar_brace() {
    let cases: &[&str] = &[
        "yah 1\nx = \"${env.A\"\n",
        "yah 1\nx = \"a ${var.x and more\"\n",
        "yah 1\nx = \"a\nb ${env.A\"\n",
    ];
    for src in cases {
        check_input("unterminated interpolation", src);
        let opening = src.find("${").unwrap();
        let (line, col) = line_col_at(src, opening);
        let diags = parse("test.yah", src).unwrap_err();
        assert!(
            diags.0.iter().any(|d| d.summary == "Invalid interpolation"
                && d.detail.contains("Unterminated interpolation")
                && (d.line, d.col) == (line, col)),
            "parse must report the unterminated interpolation at its opening: src={src:?} diags={diags:?}"
        );
    }
    // A raw string never interpolates, terminated or not.
    let src = "yah 1\nx = `${env.A`\n";
    assert!(
        parse("test.yah", src).is_ok(),
        "raw strings do not interpolate: src={src:?}"
    );
}

//! Canonical printer for `.yah` files (S4): turns an [`ast::File`] back into
//! source text in one deterministic format — `yah 1` header, 2-space indent,
//! one assignment per line, maps expanded one entry per line, scalar lists
//! kept inline, comments kept in place (leading above their statement,
//! trailing on the line the statement ends on, file tail comments last).
//!
//! Strings have no escape sequences in this language (the lexer reads
//! double-quoted strings verbatim), so re-escaping is a choice of quoting:
//! normally double quotes with the text verbatim; a literal whose text
//! contains `"` or `${` can only have come from a backtick raw string (a
//! double-quoted literal can hold neither), so it is printed raw again — a
//! raw literal never contains a backtick, so that form is always safe.
//!
//! Invariants: `print(parse(src))` re-parses to the same AST ignoring spans,
//! and printing is idempotent.

use crate::ast::{Assign, Block, Expr, ExprKind, File, Stmt, StrPart};

/// Render `file` in canonical form. Always ends with exactly one newline.
pub fn print(file: &File) -> String {
    let mut out = String::new();
    out.push_str(&format!("yah {}\n", file.version));
    for stmt in &file.stmts {
        write_stmt(&mut out, stmt, 0);
    }
    for comment in &file.tail_comments {
        out.push_str(comment);
        out.push('\n');
    }
    out
}

fn pad(level: usize) -> String {
    "  ".repeat(level)
}

fn write_leading(out: &mut String, leading: &[String], level: usize) {
    for comment in leading {
        out.push_str(&pad(level));
        out.push_str(comment);
        out.push('\n');
    }
}

fn write_trailing(out: &mut String, trailing: &Option<String>) {
    if let Some(comment) = trailing {
        out.push(' ');
        out.push_str(comment);
    }
}

fn write_stmt(out: &mut String, stmt: &Stmt, level: usize) {
    match stmt {
        Stmt::Assign(assign) => {
            write_leading(out, &assign.leading, level);
            write_assign_head(out, assign, level);
            out.push('\n');
        }
        Stmt::Block(block) => {
            write_leading(out, &block.leading, level);
            write_block(out, block, level);
            out.push('\n');
        }
    }
}

/// `key = value` plus trailing comment, with no final newline. Used for
/// top-level / block assignments and for map entries alike.
fn write_assign_head(out: &mut String, assign: &Assign, level: usize) {
    out.push_str(&pad(level));
    out.push_str(&assign.key);
    out.push_str(" = ");
    out.push_str(&expr_text(&assign.value, level));
    write_trailing(out, &assign.trailing);
}

fn write_block(out: &mut String, block: &Block, level: usize) {
    out.push_str(&pad(level));
    out.push_str(&block.kind);
    if let Some(label) = &block.label {
        out.push_str(&format!(" \"{label}\""));
    }
    if block.body.is_empty() {
        out.push_str(" {}");
    } else {
        out.push_str(" {\n");
        for stmt in &block.body {
            write_stmt(out, stmt, level + 1);
        }
        out.push_str(&pad(level));
        out.push('}');
    }
    write_trailing(out, &block.trailing);
}

/// Render a value. `level` is the indentation level of the line the value
/// starts on; multi-line values (maps, non-scalar lists) indent their
/// continuation lines relative to it and close at it.
fn expr_text(expr: &Expr, level: usize) -> String {
    match &expr.kind {
        ExprKind::Str(parts) => string_text(parts),
        ExprKind::Num(n) => number_text(*n),
        ExprKind::Bool(b) => b.to_string(),
        ExprKind::Null => "null".to_string(),
        ExprKind::Ref(path) => path.join("."),
        ExprKind::List(items) => {
            if items.is_empty() {
                return "[]".to_string();
            }
            if items.iter().all(inlineable) {
                let inner: Vec<String> = items.iter().map(|item| expr_text(item, level)).collect();
                return format!("[{}]", inner.join(", "));
            }
            let mut out = String::from("[\n");
            for item in items {
                out.push_str(&pad(level + 1));
                out.push_str(&expr_text(item, level + 1));
                out.push_str(",\n");
            }
            out.push_str(&pad(level));
            out.push(']');
            out
        }
        ExprKind::Map(entries) => {
            if entries.is_empty() {
                return "{}".to_string();
            }
            let mut out = String::from("{\n");
            for entry in entries {
                write_leading(&mut out, &entry.leading, level + 1);
                write_assign_head(&mut out, entry, level + 1);
                out.push('\n');
            }
            out.push_str(&pad(level));
            out.push('}');
            out
        }
    }
}

/// Can this value be rendered on one line? Strings with newlines and
/// non-empty maps cannot.
fn inlineable(expr: &Expr) -> bool {
    match &expr.kind {
        ExprKind::Str(parts) => parts
            .iter()
            .all(|part| !matches!(part, StrPart::Lit(text) if text.contains('\n'))),
        ExprKind::Num(_) | ExprKind::Bool(_) | ExprKind::Null | ExprKind::Ref(_) => true,
        ExprKind::List(items) => items.iter().all(inlineable),
        ExprKind::Map(entries) => entries.is_empty(),
    }
}

fn string_text(parts: &[StrPart]) -> String {
    if parts.iter().any(|part| matches!(part, StrPart::Interp(..))) {
        // Interpolated strings are double-quoted; their literal segments came
        // from a double-quoted source string, so they hold no `"`.
        let mut out = String::from("\"");
        for part in parts {
            match part {
                StrPart::Lit(text) => out.push_str(text),
                StrPart::Interp(path, _) => {
                    out.push_str("${");
                    out.push_str(&path.join("."));
                    out.push('}');
                }
            }
        }
        out.push('"');
        return out;
    }
    let text: String = parts
        .iter()
        .map(|part| match part {
            StrPart::Lit(text) => text.as_str(),
            StrPart::Interp(..) => unreachable!("handled above"),
        })
        .collect();
    if text.contains('"') || text.contains("${") {
        // Only reachable for a literal that came from a raw string, which
        // never contains a backtick: raw form is safe and round-trips.
        format!("`{text}`")
    } else {
        format!("\"{text}\"")
    }
}

fn number_text(n: f64) -> String {
    if n.is_finite() && n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_992.0 {
        format!("{}", n as i64)
    } else {
        format!("{n}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ast::Span;
    use crate::parser::parse;

    fn strip(file: &mut File) {
        for stmt in &mut file.stmts {
            strip_stmt(stmt);
        }
    }

    fn strip_stmt(stmt: &mut Stmt) {
        match stmt {
            Stmt::Assign(assign) => {
                assign.span = Span::default();
                strip_expr(&mut assign.value);
            }
            Stmt::Block(block) => {
                block.span = Span::default();
                for stmt in &mut block.body {
                    strip_stmt(stmt);
                }
            }
        }
    }

    fn strip_expr(expr: &mut Expr) {
        expr.span = Span::default();
        match &mut expr.kind {
            ExprKind::Str(parts) => {
                for part in parts {
                    if let StrPart::Interp(_, span) = part {
                        *span = Span::default();
                    }
                }
            }
            ExprKind::List(items) => items.iter_mut().for_each(strip_expr),
            ExprKind::Map(entries) => {
                for entry in entries {
                    entry.span = Span::default();
                    strip_expr(&mut entry.value);
                }
            }
            _ => {}
        }
    }

    fn round_trip(src: &str) -> String {
        let first = parse("test.yah", src).unwrap();
        let printed = print(&first);
        let mut second = parse("test.yah", &printed).unwrap();
        let mut first = first;
        strip(&mut first);
        strip(&mut second);
        assert_eq!(first, second, "printed:\n{printed}");
        assert_eq!(print(&second), printed, "print is not idempotent");
        printed
    }

    #[test]
    fn canonical_layout_comments_maps_and_lists() {
        let src = "yah 1\n// lead\nx   =    1 // trail\nblk \"l\" {\na = [1,2]\nm = { k = \"v\", k2 = true }\n}\n// tail\n";
        let printed = round_trip(src);
        assert_eq!(
            printed,
            "yah 1\n// lead\nx = 1 // trail\nblk \"l\" {\n  a = [1, 2]\n  m = {\n    k = \"v\"\n    k2 = true\n  }\n}\n// tail\n"
        );
    }

    #[test]
    fn empty_forms_and_numbers() {
        let src = "yah 1\nopen { }\nm = { }\nl = [ ]\ns = \"\"\na = 1.5\nb = -2\nc = 3.0\n";
        let printed = round_trip(src);
        assert_eq!(printed, "yah 1\nopen {}\nm = {}\nl = []\ns = \"\"\na = 1.5\nb = -2\nc = 3\n");
    }

    #[test]
    fn raw_string_with_quote_and_dollar_brace_stays_raw() {
        let src = "yah 1\nx = `say \"hi\" ${not}`\n";
        let printed = round_trip(src);
        assert_eq!(printed, src);
    }

    #[test]
    fn interpolated_and_ref_values() {
        let src = "yah 1\ncmd = [\"pi\", \"${harnesses.builder.model_id}\"]\nwho = env.USER\nflag = null\n";
        let printed = round_trip(src);
        assert_eq!(printed, src);
    }

    #[test]
    fn block_trailing_and_tail_comments() {
        let src = "yah 1\n// open note\nblk {\n  y = 1\n  // inner lead\n  z = 2\n} // block trail\n// tail1\n// tail2\n";
        let printed = round_trip(src);
        assert_eq!(
            printed,
            "yah 1\n// open note\nblk {\n  y = 1\n  // inner lead\n  z = 2\n} // block trail\n// tail1\n// tail2\n"
        );
    }

    #[test]
    fn canonical_fixture_round_trips() {
        round_trip(include_str!("../tests/fixtures/canonical.yah"));
    }

    #[test]
    fn every_yah_file_round_trips() {
        // Named exclusion only: a parse-error fixture by design (unclosed interpolation).
        const EXCLUDED: &[&str] = &["A-39-unclosed-interpolation.yah"];
        let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let mut dirs = vec![manifest.join("examples"), manifest.join("tests/fixtures")];
        if let Some(lab) = manifest.ancestors().nth(4) { let scn = lab.join("notes/scn"); if scn.is_dir() { dirs.push(scn); } }
        let (mut checked, mut excluded) = (0usize, 0usize);
        for dir in &dirs {
            let mut paths: Vec<std::path::PathBuf> = std::fs::read_dir(dir).unwrap().filter_map(|e| e.ok().map(|e| e.path())).filter(|p| p.extension().is_some_and(|x| x == "yah")).collect();
            paths.sort();
            for path in paths {
                let name = path.file_name().unwrap().to_string_lossy().into_owned();
                if EXCLUDED.contains(&name.as_str()) { excluded += 1; continue; }
                let src = std::fs::read_to_string(&path).unwrap();
                let first = parse(&name, &src).unwrap_or_else(|d| panic!("{name}: {}", d.render(&src)));
                let printed = print(&first);
                let second = parse(&name, &printed).unwrap_or_else(|d| panic!("{name} reparse: {}", d.render(&printed)));
                let (mut a, mut b) = (first, second); strip(&mut a); strip(&mut b);
                assert_eq!(a, b, "{name}: AST differs after print");
                assert_eq!(print(&b), printed, "{name}: print is not idempotent");
                checked += 1;
            }
        }
        assert!(checked >= 44, "expected at least 44 .yah files, checked {checked}");
        assert_eq!(excluded, 1, "expected exactly the 1 named exclusion");
    }
}

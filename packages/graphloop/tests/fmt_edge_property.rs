//! Formatter round-trip properties for synthetic sources beyond the
//! example and fixture corpus: empty and nested blocks, maps and lists,
//! comments at file and block edges and inside maps, raw and quoted
//! strings, and interpolations and references used as values.
//!
//! For every source: `parse -> print -> parse` is AST-equal ignoring
//! spans, and printing a second time yields the identical text.

use graphloop::ast::{ExprKind, File, Span, Stmt, StrPart};
use graphloop::fmt::print;
use graphloop::parser::parse;

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

fn strip_expr(expr: &mut graphloop::ast::Expr) {
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

fn check(src: &str) {
    let first = parse("test.yah", src)
        .unwrap_or_else(|d| panic!("source must parse: src={src:?} diag={}", d.render(src)));
    let printed = print(&first);
    assert!(
        printed.ends_with('\n') && !printed.ends_with("\n\n"),
        "printed output must end with exactly one newline: src={src:?} printed={printed:?}"
    );
    assert!(
        printed.lines().all(|line| line == line.trim_end()),
        "printed lines must not carry trailing whitespace: src={src:?} printed={printed:?}"
    );
    let second = parse("test.yah", &printed).unwrap_or_else(|d| {
        panic!(
            "printed output must re-parse: src={src:?} printed={printed:?} diag={}",
            d.render(&printed)
        )
    });
    let (mut a, mut b) = (first, second);
    strip(&mut a);
    strip(&mut b);
    assert_eq!(
        a, b,
        "AST differs after print: src={src:?} printed={printed:?}"
    );
    assert_eq!(print(&b), printed, "print is not idempotent: src={src:?}");
}

fn check_all(sources: &[&str]) {
    for src in sources {
        check(src);
    }
}

#[test]
fn empty_and_nested_collections_round_trip() {
    check_all(&[
        "yah 1\n",
        "yah 1\nempty {}\n",
        "yah 1\nempty { }\n",
        "yah 1\na { b { c {} } }\n",
        "yah 1\nm = {}\nl = []\ns = \"\"\n",
        "yah 1\nm = { inner = {}, list = [] }\n",
        "yah 1\nl = [[], [[]], {}]\n",
        "yah 1\nl = [{}, {}]\n",
        "yah 1\nm = { a = { b = { c = [] } } }\n",
        "yah 1\nblk { m = { k = [1, { deep = true }] } }\n",
        "yah 1\nl = [[1, 2], [3]]\n",
        "yah 1\nl = [{ a = 1 }, { b = [\"x\"] }]\n",
        "yah 1\nm = { list = [{ a = 1 }, { b = 2 }], empty = {} }\n",
    ]);
    // Generated nesting: wrap a scalar leaf in alternating list and map
    // layers, and in nested blocks, at several depths.
    for depth in 1..=4usize {
        let mut value = String::from("7");
        for layer in 0..depth {
            value = if layer % 2 == 0 {
                format!("[{value}]")
            } else {
                format!("{{ k = {value} }}")
            };
        }
        check(&format!("yah 1\nx = {value}\n"));
        let mut block = String::from("x = 7\n");
        for _ in 0..depth {
            block = format!("wrap {{\n{block}}}\n");
        }
        check(&format!("yah 1\n{block}"));
    }
}

#[test]
fn comments_at_edges_and_inside_maps_round_trip() {
    check_all(&[
        "yah 1\n// only a comment\n",
        "yah 1\n// one\n// two\n",
        "yah 1\n// lead\nx = 1 // trail\n// tail\n",
        "yah 1\nx = 1\n// tail one\n// tail two\n",
        "yah 1\nblk {\n  // inner lead\n  x = 1 // inner trail\n}\n",
        "yah 1\nblk {\n}\n",
        "yah 1\nblk \"label\" { // open trail is not kept on the brace line\n  x = 1\n} // close trail\n",
        "yah 1\nm = {\n  // entry lead\n  k = \"v\" // entry trail\n  k2 = 2\n}\n",
        "yah 1\nm = { // map open\n  k = 1\n}\n",
        "yah 1\n// lead for block\nblk {\n  // lead for assign\n  x = 1\n} // trail for block\n// file tail\n",
        "yah 1\nx = [1, 2] // after list\nm = { k = true } // after map\n",
    ]);
}

#[test]
fn raw_quoted_and_interpolated_strings_round_trip() {
    check_all(&[
        "yah 1\ns = \"\"\n",
        "yah 1\ns = \"plain\"\n",
        "yah 1\ns = `plain`\n",
        "yah 1\ns = `say \"hi\"`\n",
        "yah 1\ns = `cost ${not_interp}`\n",
        "yah 1\ns = \"pre ${env.USER} post\"\n",
        "yah 1\ns = \"${a.b}\"\n",
        "yah 1\ns = \"${a.b} and ${c.d.e} and ${f}\"\n",
        "yah 1\ns = \"back\\slash\"\n",
        "yah 1\ns = \"unicode λ 雪 \"\n",
        "yah 1\ns = `unicode λ 雪`\n",
        "yah 1\nl = [\"${env.HOME}\", `raw \"q\"`, \"plain\"]\n",
        "yah 1\nm = { cmd = \"run ${tools.build} now\", raw = `a ${b} c` }\n",
        "yah 1\nblk { s = \"${deep.ref.path}\" }\n",
    ]);
}

#[test]
fn references_and_scalars_in_collections_round_trip() {
    check_all(&[
        "yah 1\nr = env.USER\n",
        "yah 1\nr = a.b.c.d\n",
        "yah 1\nt = true\nf = false\nn = null\n",
        "yah 1\nzero = 0\nneg = -12\nfrac = 0.25\nbig = 1000000\n",
    ]);
    // Every scalar/reference value in every collection position.
    let values = [
        "1",
        "-2.5",
        "true",
        "false",
        "null",
        "env.USER",
        "a.b.c",
        "\"text\"",
        "\"${env.X}\"",
    ];
    for value in values {
        check(&format!("yah 1\nx = {value}\n"));
        check(&format!("yah 1\nx = [{value}]\n"));
        check(&format!("yah 1\nx = {{ k = {value} }}\n"));
        check(&format!("yah 1\nblk {{ x = {value} }}\n"));
    }
    // Pairs in one inline list and one map.
    for (i, a) in values.iter().enumerate() {
        let b = values[(i + 3) % values.len()];
        check(&format!("yah 1\nx = [{a}, {b}]\n"));
        check(&format!("yah 1\nx = {{ first = {a}, second = {b} }}\n"));
    }
}

#[test]
fn whitespace_variants_normalise_and_round_trip() {
    check_all(&[
        "yah 1\nx=1\n",
        "yah 1\nx    =    [ 1 ,2 ]\n",
        "yah 1\n\n\nx = 1\n\n\ny = 2\n",
        "yah 1\nx = 1",
        "yah 1\nblk{\nx=1\n}\n",
        "yah 1\nm={k=\"v\",k2=[true,null]}\n",
        "yah 1\nx = \"multi word value\"\n",
    ]);
    // The whitespace variants above describe the same file as the
    // canonical spelling: their printed forms must coincide.
    let canonical = print(&parse("test.yah", "yah 1\nx = 1\ny = 2\n").unwrap());
    let messy = print(&parse("test.yah", "yah 1\n\nx    =    1\n\n\ny = 2").unwrap());
    assert_eq!(messy, canonical);
}

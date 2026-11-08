//! Resolve/refs property tests: generated reference paths and generated
//! specs must never panic the resolver, valid forms must resolve or stay
//! late-bound, and every invalid form must fail with exactly one
//! `Unknown reference` diagnostic that names the path as written and
//! spells out the valid forms. Duplicate variables are reported once.
//!
//! Deterministic, std only: fixed-seed xorshift64* corpus generation, no
//! new dependencies. Specs are built directly as ASTs so shapes the
//! parser can never produce (empty segments, empty paths, over-deep
//! paths) reach `resolve` exactly as generated.

use std::collections::BTreeMap;
use std::panic::{catch_unwind, AssertUnwindSafe};

use graphloop::ast::{Assign, Block, Expr, ExprKind, File, Span, Stmt, StrPart};
use graphloop::refs::{Reference, Stage};
use graphloop::resolve::resolve;
use graphloop::scope::Scope;

const SEED: u64 = 0x9E37_79B9_7F4A_7C15;

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
    fn pick<'a>(&mut self, pool: &[&'a str]) -> &'a str {
        pool[self.below(pool.len())]
    }
}

const ROOTS: &[&str] = &[
    "var",
    "env",
    "vault",
    "harnesses",
    "nope",
    "",
    "VAR",
    "vars",
];
const SEGMENTS: &[&str] = &[
    "alpha", "beta", "main", "builder", "model", "model_id", "TOKEN", "x", "", "nope",
];
const VAR_NAMES: &[&str] = &["alpha", "beta"];
const VAULT_NAMES: &[&str] = &["main"];
const HARNESS_NAMES: &[&str] = &["builder"];

fn sp() -> Span {
    Span::default()
}

fn str_lit(s: &str) -> Expr {
    Expr {
        kind: ExprKind::Str(vec![StrPart::Lit(s.to_string())]),
        span: sp(),
    }
}

fn assign(key: &str, value: Expr) -> Stmt {
    Stmt::Assign(Assign {
        key: key.to_string(),
        value,
        span: sp(),
        leading: Vec::new(),
        trailing: None,
    })
}

fn block(kind: &str, label: &str, body: Vec<Stmt>) -> Stmt {
    Stmt::Block(Block {
        kind: kind.to_string(),
        label: Some(label.to_string()),
        body,
        span: sp(),
        leading: Vec::new(),
        trailing: None,
    })
}

fn var_block(name: &str, default: &str) -> Stmt {
    block("variable", name, vec![assign("default", str_lit(default))])
}

/// Declared scaffolding (vars alpha/beta, vault main, harness builder)
/// plus one consumer assignment holding `usage`.
fn spec_with_usage(usage: Expr) -> File {
    File {
        name: "prop.yah".to_string(),
        version: 1,
        stmts: vec![
            var_block("alpha", "A"),
            var_block("beta", "B"),
            block("vault", "main", vec![]),
            block("harness", "builder", vec![]),
            block("team", "t", vec![assign("x", usage)]),
        ],
        tail_comments: Vec::new(),
    }
}

fn run_resolve(file: File) -> Result<File, String> {
    let scope = Scope::build(&file);
    match catch_unwind(AssertUnwindSafe(|| resolve(file, &BTreeMap::new(), &scope))) {
        Ok(Ok(out)) => Ok(out),
        Ok(Err(diags)) => Err(format!("{diags:?}")),
        Err(payload) => {
            let msg = payload
                .downcast_ref::<&str>()
                .map(|s| s.to_string())
                .or_else(|| payload.downcast_ref::<String>().cloned())
                .unwrap_or_else(|| "<non-string panic>".to_string());
            panic!("resolve panicked: {msg}");
        }
    }
}

fn consumer_expr(file: &File) -> &ExprKind {
    let Stmt::Block(team) = file.stmts.last().unwrap() else {
        panic!("last stmt is the consumer block")
    };
    let Stmt::Assign(a) = &team.body[0] else {
        panic!("consumer body is one assignment")
    };
    &a.value.kind
}

/// Independent expectation: true iff `resolve` must accept this path
/// against the declared scaffolding (value or late-bound).
fn expected_accept(path: &[String]) -> bool {
    match Reference::parse(path) {
        Ok(Reference::Var(name)) => VAR_NAMES.contains(&name.as_str()),
        Ok(Reference::Env(_)) => true,
        Ok(Reference::Vault { vault, .. }) => VAULT_NAMES.contains(&vault.as_str()),
        Ok(Reference::HarnessModel(h)) | Ok(Reference::HarnessModelId(h)) => {
            HARNESS_NAMES.contains(&h.as_str())
        }
        Err(_) => false,
    }
}

fn check_one_path(path: &[String], interp: bool) {
    let usage = if interp {
        Expr {
            kind: ExprKind::Str(vec![
                StrPart::Lit("pre-".to_string()),
                StrPart::Interp(path.to_vec(), sp()),
                StrPart::Lit("-post".to_string()),
            ]),
            span: sp(),
        }
    } else {
        Expr {
            kind: ExprKind::Ref(path.to_vec()),
            span: sp(),
        }
    };
    let joined = path.join(".");
    let result = run_resolve(spec_with_usage(usage));
    if expected_accept(path) {
        let out =
            result.unwrap_or_else(|d| panic!("path {joined:?} must resolve, got diagnostics: {d}"));
        match (interp, Reference::parse(path)) {
            (false, Ok(Reference::Var(_))) => assert!(
                matches!(consumer_expr(&out), ExprKind::Str(_)),
                "bare var ref {joined:?} must be replaced by its value"
            ),
            (false, _) => assert_eq!(
                consumer_expr(&out),
                &ExprKind::Ref(path.to_vec()),
                "late-bound ref {joined:?} must be left in place"
            ),
            (true, Ok(Reference::Var(name))) => {
                let want = if name == "alpha" {
                    "pre-A-post"
                } else {
                    "pre-B-post"
                };
                assert_eq!(
                    consumer_expr(&out),
                    &ExprKind::Str(vec![StrPart::Lit(want.to_string())]),
                    "interp var {joined:?} must splice its value text"
                );
            }
            (true, _) => assert!(
                matches!(consumer_expr(&out), ExprKind::Str(parts) if parts.iter().any(|p| matches!(p, StrPart::Interp(..)))),
                "late-bound interp {joined:?} must be left in place"
            ),
        }
    } else {
        let rendered = result
            .err()
            .unwrap_or_else(|| panic!("path {joined:?} must be rejected"));
        assert_eq!(
            rendered.matches("Unknown reference").count(),
            1,
            "path {joined:?}: exactly one Unknown reference diagnostic, got: {rendered}"
        );
        assert!(
            rendered.contains(&format!("\\\"{joined}\\\"")),
            "path {joined:?}: diagnostic must name the path as written, got: {rendered}"
        );
        assert!(
            rendered.contains(&graphloop::refs::valid_forms()),
            "path {joined:?}: diagnostic must spell out the valid forms, got: {rendered}"
        );
        assert!(
            rendered.contains("Valid references are var.<name>"),
            "path {joined:?}: valid-forms text must be the canonical wording, got: {rendered}"
        );
    }
}

#[test]
fn reference_parse_generated_paths_never_panic_and_round_trip() {
    let mut rng = Rng(SEED);
    for i in 0..2000 {
        let len = rng.below(6);
        let mut path: Vec<String> = Vec::with_capacity(len);
        if len > 0 {
            path.push(rng.pick(ROOTS).to_string());
            for _ in 1..len {
                path.push(rng.pick(SEGMENTS).to_string());
            }
        }
        match Reference::parse(&path) {
            Ok(r) => {
                assert_eq!(r.path(), path, "case {i}: a parsed reference must print back as exactly the path it parsed from");
                assert_eq!(
                    r.to_string(),
                    path.join("."),
                    "case {i}: Display must be the dotted path"
                );
                let stage = match &r {
                    Reference::Var(_) => Stage::Compile,
                    Reference::HarnessModel(_) | Reference::HarnessModelId(_) => Stage::Plan,
                    Reference::Env(_) | Reference::Vault { .. } => Stage::Apply,
                };
                assert_eq!(
                    r.stage(),
                    stage,
                    "case {i}: stage must follow the binding table"
                );
            }
            Err(e) => assert_eq!(
                e.root,
                path.first().cloned(),
                "case {i}: a rejected path must keep its root word"
            ),
        }
    }
}

#[test]
fn every_valid_form_with_generated_names_parses_and_resolves() {
    let names = ["a", "alpha", "work_dir", "API_KEY", "X1", "h-2"];
    let mut rng = Rng(SEED ^ 0xA57);
    for _ in 0..200 {
        let n = rng.pick(&names);
        for path in [
            vec!["var".to_string(), n.to_string()],
            vec!["env".to_string(), n.to_string()],
            vec!["vault".to_string(), n.to_string(), "KEY".to_string()],
            vec!["harnesses".to_string(), n.to_string(), "model".to_string()],
            vec![
                "harnesses".to_string(),
                n.to_string(),
                "model_id".to_string(),
            ],
        ] {
            let r =
                Reference::parse(&path).unwrap_or_else(|e| panic!("{path:?} must parse: {e:?}"));
            assert_eq!(r.path(), path);
        }
    }
    // The same five forms against the declared scaffolding resolve.
    for path in [
        vec!["var".to_string(), "alpha".to_string()],
        vec!["env".to_string(), "ANYTHING".to_string()],
        vec!["vault".to_string(), "main".to_string(), "TOKEN".to_string()],
        vec![
            "harnesses".to_string(),
            "builder".to_string(),
            "model".to_string(),
        ],
        vec![
            "harnesses".to_string(),
            "builder".to_string(),
            "model_id".to_string(),
        ],
    ] {
        check_one_path(&path, false);
        check_one_path(&path, true);
    }
}

#[test]
fn resolve_generated_paths_classify_exactly_and_name_the_path() {
    // Fixed edge shapes first: unknown roots, empty path, empty segments,
    // over-deep paths, wrong tails, undeclared names of every kind.
    let fixed: Vec<Vec<String>> = [
        vec![],
        vec!["var"],
        vec!["var", ""],
        vec!["var", "", "x"],
        vec!["var", "alpha", "extra"],
        vec!["var", "alpha", "a", "b", "c"],
        vec!["var", "undeclared"],
        vec!["env"],
        vec!["env", ""],
        vec!["env", "A", "B"],
        vec!["vault"],
        vec!["vault", "main"],
        vec!["vault", "main", "K", "extra"],
        vec!["vault", "other", "K"],
        vec!["vault", "", "K"],
        vec!["harnesses"],
        vec!["harnesses", "builder"],
        vec!["harnesses", "builder", "tools"],
        vec!["harnesses", "builder", "model", "x"],
        vec!["harnesses", "other", "model"],
        vec!["harnesses", "other", "model_id"],
        vec!["nope", "x"],
        vec!["nope"],
        vec!["", "x"],
        vec!["VAR", "alpha"],
    ]
    .iter()
    .map(|v| v.iter().map(|s| s.to_string()).collect())
    .collect();
    for (i, path) in fixed.iter().enumerate() {
        check_one_path(path, i % 2 == 0);
    }
    // Then the generated corpus, alternating bare refs and interpolations.
    let mut rng = Rng(SEED ^ 0x5EED);
    for i in 0..600 {
        let len = rng.below(6);
        let mut path: Vec<String> = Vec::with_capacity(len);
        if len > 0 {
            path.push(rng.pick(ROOTS).to_string());
            for _ in 1..len {
                path.push(rng.pick(SEGMENTS).to_string());
            }
        }
        check_one_path(&path, i % 2 == 1);
    }
}

#[test]
fn undeclared_close_name_offers_a_did_you_mean_hint() {
    let path = vec!["var".to_string(), "alpa".to_string()];
    let rendered = run_resolve(spec_with_usage(Expr {
        kind: ExprKind::Ref(path),
        span: sp(),
    }))
    .expect_err("undeclared var must be rejected");
    assert!(
        rendered.contains("Did you mean \\\"alpha\\\""),
        "close undeclared name must suggest the declared one, got: {rendered}"
    );
}

#[test]
fn duplicate_variable_is_reported_exactly_once() {
    let mut rng = Rng(SEED ^ 0xD09);
    for _ in 0..100 {
        let name = rng.pick(&["alpha", "beta", "gamma", "work_dir"]);
        let other = rng.pick(&["one", "two", "three"]);
        let file = File {
            name: "dup.yah".to_string(),
            version: 1,
            stmts: vec![
                var_block(name, "1"),
                var_block(other, "x"),
                var_block(name, "2"),
            ],
            tail_comments: Vec::new(),
        };
        let rendered = run_resolve(file).expect_err("a duplicated variable must be rejected");
        assert_eq!(
            rendered.matches("Duplicate variable").count(),
            1,
            "name {name:?}: the duplicate must be reported exactly once, got: {rendered}"
        );
        assert!(
            rendered.contains(&format!("\\\"{name}\\\"")),
            "the diagnostic must name the duplicated variable, got: {rendered}"
        );
        assert!(
            !rendered.contains("Unknown reference"),
            "a duplicate is not a reference error, got: {rendered}"
        );
    }
}

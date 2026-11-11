//! Property tests for schema diagnostic quality: generated assignments with
//! wrong-typed values, unknown fields and missing required fields across block
//! kinds must never panic and never be silently accepted. Every diagnostic must
//! name the field, state what was expected, and carry a span inside the source,
//! and secret-shaped values must never appear in rendered diagnostic text.

use std::collections::BTreeMap;

use h1::yah::diag::{Diagnostics, Severity};
use h1::yah::load::load_str;

const SEED: u64 = 0x5C4E4A11D1A6;

struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
    fn pick<'a>(&mut self, xs: &'a [&'a str]) -> &'a str {
        xs[(self.next() % xs.len() as u64) as usize]
    }
}

fn err_diags(src: &str) -> Diagnostics {
    load_str("x.yah", src, &BTreeMap::new()).expect_err("invalid source must be rejected")
}

fn assert_spans_inside(diags: &Diagnostics, src: &str) {
    assert!(
        !diags.0.is_empty(),
        "an invalid source must produce diagnostics"
    );
    for d in &diags.0 {
        assert_eq!(d.file, "x.yah", "diagnostic must name the file: {d:?}");
        assert_eq!(
            d.severity,
            Severity::Error,
            "schema problems are errors: {d:?}"
        );
        let line = src
            .lines()
            .nth(d.line.saturating_sub(1) as usize)
            .unwrap_or_else(|| panic!("span line {} must be inside the source: {d:?}", d.line));
        assert!(d.line >= 1, "line is 1-based: {d:?}");
        assert!(d.col >= 1, "col is 1-based: {d:?}");
        assert!(
            (d.col as usize) <= line.chars().count() + 1,
            "span col {} must be inside line {line:?}: {d:?}",
            d.col
        );
        assert!(d.len >= 1, "span must cover at least one character: {d:?}");
    }
}

fn harness_block(label: &str) -> String {
    format!(
        "harness \"{label}\" {{\n kind = \"h1\"\n role = \"builder\"\n open {{ command = [\"pi\"] }}\n}}\n"
    )
}

#[test]
fn wrong_typed_values_name_the_field_and_expected_type() {
    let mut rng = Rng(SEED);
    for _ in 0..120 {
        let label = rng.pick(&["alpha", "beta", "gamma", "delta"]);
        let case = rng.below(15);
        let (src, field, expected, kind) = match case {
            0 => (
                format!("yah 1\nprovider \"{label}\" {{\n type = 123\n}}\n"),
                "type",
                "a string",
                "provider",
            ),
            1 => (
                format!(
                    "yah 1\nprovider \"{label}\" {{\n type = \"anthropic\"\n base_url = true\n}}\n"
                ),
                "base_url",
                "a string",
                "provider",
            ),
            2 => (
                format!("yah 1\nmodel \"{label}\" {{\n provider = [\"x\"]\n}}\n"),
                "provider",
                "a string",
                "model",
            ),
            3 => (
                "yah 1\nsystem_one {\n fallback = 123\n}\n".to_string(),
                "fallback",
                "a string",
                "system_one",
            ),
            4 => (
                "yah 1\nimage {\n provider = true\n}\n".to_string(),
                "provider",
                "a string",
                "image",
            ),
            5 => (
                format!("yah 1\napi \"{label}\" {{\n type = 123\n}}\n"),
                "type",
                "a string",
                "api",
            ),
            6 => (
                format!(
                    "yah 1\nharness \"{label}\" {{\n kind = 123\n role = \"builder\"\n open {{ command = [\"pi\"] }}\n}}\n"
                ),
                "kind",
                "a string",
                "harness",
            ),
            7 => (
                format!(
                    "yah 1\nharness \"{label}\" {{\n kind = \"h1\"\n role = [\"x\"]\n open {{ command = [\"pi\"] }}\n}}\n"
                ),
                "role",
                "a string",
                "harness",
            ),
            8 => (
                format!("yah 1\nteam \"{label}\" {{\n root = 123\n}}\n"),
                "root",
                "a string",
                "team",
            ),
            9 => (
                format!("yah 1\noutput \"{label}\" {{\n value = [\"x\"]\n}}\n"),
                "value",
                "a string, number, bool or reference",
                "output",
            ),
            10 => (
                format!(
                    "yah 1\nvariable \"{label}\" {{\n type = \"number\"\n default = \"abc\"\n}}\n"
                ),
                "default",
                "a number",
                "variable",
            ),
            11 => (
                "yah 1\ndefaults {\n sandbox = 123\n}\n".to_string(),
                "sandbox",
                "a string",
                "defaults",
            ),
            12 => (
                format!(
                    "yah 1\nharness \"{label}\" {{\n kind = \"h1\"\n role = \"builder\"\n open {{ command = [\"pi\"] cols = \"wide\" }}\n}}\n"
                ),
                "cols",
                "",
                "harness",
            ),
            13 => (
                format!(
                    "yah 1\n{}\nteam \"t\" {{\n root = \"{label}\"\n}}\nworkflow \"w\" {{\n team = \"t\"\n steps = \"build\"\n}}\n",
                    harness_block(label)
                ),
                "steps",
                "",
                "workflow",
            ),
            _ => (
                format!("yah 1\nteam \"{label}\" {{\n root = \"r\"\n graph = \"yes\"\n}}\n"),
                "graph",
                "",
                "team",
            ),
        };
        let diags = err_diags(&src);
        assert_spans_inside(&diags, &src);
        let hit = diags
            .0
            .iter()
            .find(|d| {
                d.summary == "Incorrect attribute value type"
                    && d.detail.contains(&format!("\"{field}\""))
            })
            .unwrap_or_else(|| {
                panic!(
                    "case {case}: a type diagnostic naming \"{field}\" is required, got: {diags:?}"
                )
            });
        assert!(
            hit.detail.contains("is required."),
            "case {case}: detail must state the expectation, got: {}",
            hit.detail
        );
        if !expected.is_empty() {
            assert!(
                hit.detail.contains(&format!("{expected} is required.")),
                "case {case}: detail must state expected type {expected:?}, got: {}",
                hit.detail
            );
        }
        let ctx = hit.context.clone().unwrap_or_default();
        assert!(
            ctx.contains(kind),
            "case {case}: context must name the {kind} block, got: {ctx:?}"
        );
    }
    // Invalid-value diagnostics state expected vs found explicitly.
    let src = "yah 1\napi \"fs\" {\n type = \"bogus\"\n}\n";
    let diags = err_diags(src);
    assert_spans_inside(&diags, src);
    let hit = diags
        .0
        .iter()
        .find(|d| d.summary == "Invalid value")
        .expect("an enum violation must be an Invalid value diagnostic");
    assert!(
        hit.detail.contains("\"type\"")
            && hit.detail.contains("expected one of")
            && hit.detail.contains("bogus")
            && hit.detail.contains("mcp"),
        "detail must name the field, the expected set and the found value, got: {}",
        hit.detail
    );
}

#[test]
fn unknown_fields_are_named_across_block_kinds() {
    let mut rng = Rng(SEED ^ 0xAB1C);
    for _ in 0..120 {
        let label = rng.pick(&["alpha", "beta", "gamma", "delta"]);
        let key = format!("bogus{}", rng.below(1000));
        let case = rng.below(11);
        let (src, kind) = match case {
            0 => (
                format!(
                    "yah 1\nvariable \"{label}\" {{\n type = \"string\"\n default = \"x\"\n {key} = 123\n}}\n"
                ),
                "variable",
            ),
            1 => (
                format!("yah 1\ndefaults {{\n model_policy = \"system-one\"\n {key} = 123\n}}\n"),
                "defaults",
            ),
            2 => (
                format!(
                    "yah 1\nprovider \"{label}\" {{\n type = \"anthropic\"\n {key} = 123\n}}\n"
                ),
                "provider",
            ),
            3 => (
                format!(
                    "yah 1\nprovider \"anthropic\" {{\n type = \"anthropic\"\n}}\nmodel \"{label}\" {{\n provider = \"anthropic\"\n {key} = 123\n}}\n"
                ),
                "model",
            ),
            4 => (
                format!(
                    "yah 1\nprovider \"anthropic\" {{\n type = \"anthropic\"\n}}\nmodel \"sonnet\" {{\n provider = \"anthropic\"\n}}\nsystem_one {{\n fallback = \"sonnet\"\n {key} = 123\n}}\n"
                ),
                "system_one",
            ),
            5 => (
                format!(
                    "yah 1\nprovider \"anthropic\" {{\n type = \"anthropic\"\n}}\nimage {{\n provider = \"anthropic\"\n {key} = 123\n}}\n"
                ),
                "image",
            ),
            6 => (
                format!(
                    "yah 1\napi \"{label}\" {{\n type = \"mcp\"\n command = [\"x\"]\n {key} = 123\n}}\n"
                ),
                "api",
            ),
            7 => (
                format!(
                    "yah 1\nharness \"{label}\" {{\n kind = \"h1\"\n role = \"builder\"\n {key} = 123\n open {{ command = [\"pi\"] }}\n}}\n"
                ),
                "harness",
            ),
            8 => (
                format!(
                    "yah 1\n{}\nteam \"{label}\" {{\n root = \"alpha\"\n {key} = 123\n}}\n",
                    harness_block("alpha")
                ),
                "team",
            ),
            9 => (
                format!(
                    "yah 1\n{}\nteam \"t\" {{\n root = \"alpha\"\n}}\nworkflow \"{label}\" {{\n team = \"t\"\n steps = [\"s\"]\n {key} = 123\n}}\n",
                    harness_block("alpha")
                ),
                "workflow",
            ),
            _ => (
                format!("yah 1\noutput \"{label}\" {{\n value = \"x\"\n {key} = 123\n}}\n"),
                "output",
            ),
        };
        let diags = err_diags(&src);
        assert_spans_inside(&diags, &src);
        let hit = diags
            .0
            .iter()
            .find(|d| d.summary == "Unsupported argument")
            .unwrap_or_else(|| {
                panic!(
                    "case {case}: an unknown field must be an Unsupported argument, got: {diags:?}"
                )
            });
        assert_eq!(
            hit.detail,
            format!("An argument named \"{key}\" is not expected here."),
            "case {case}: detail must name the field as written"
        );
        let ctx = hit.context.clone().unwrap_or_default();
        assert!(
            ctx.contains(kind),
            "case {case}: context must name the {kind} block, got: {ctx:?}"
        );
    }
    // A close misspelling carries a did-you-mean hint naming a real field.
    let src = "yah 1\nharness \"b\" {\n kind = \"h1\"\n role = \"builder\"\n modl = \"sonnet\"\n open { command = [\"pi\"] }\n}\n";
    let diags = err_diags(src);
    let hit = diags
        .0
        .iter()
        .find(|d| d.summary == "Unsupported argument")
        .expect("modl must be unsupported");
    assert_eq!(
        hit.hint.as_deref(),
        Some("Did you mean \"model\"?"),
        "a close field name must suggest the real field, got: {hit:?}"
    );
}

#[test]
fn missing_required_fields_are_named_across_block_kinds() {
    let mut rng = Rng(SEED ^ 0x1155);
    for _ in 0..170 {
        let label = rng.pick(&["alpha", "beta", "gamma", "delta"]);
        let case = rng.below(17);
        let (src, field, kind) = match case {
            0 => (
                format!("yah 1\nvariable \"{label}\" {{\n type = \"string\"\n}}\n"),
                "default",
                "variable",
            ),
            1 => (
                format!("yah 1\nprovider \"{label}\" {{\n api_key = env.SOME_KEY\n}}\n"),
                "type",
                "provider",
            ),
            2 => (
                format!("yah 1\nmodel \"{label}\" {{\n id = \"m1\"\n}}\n"),
                "provider",
                "model",
            ),
            3 => (
                "yah 1\nsystem_one {\n student = \"s.json\"\n}\n".to_string(),
                "fallback",
                "system_one",
            ),
            4 => (
                "yah 1\nimage {\n generate = \"g\"\n}\n".to_string(),
                "provider",
                "image",
            ),
            5 => (
                format!("yah 1\napi \"{label}\" {{\n command = [\"x\"]\n}}\n"),
                "type",
                "api",
            ),
            6 => (
                format!("yah 1\napi \"{label}\" {{\n type = \"mcp\"\n}}\n"),
                "command",
                "api",
            ),
            7 => (
                format!("yah 1\napi \"{label}\" {{\n type = \"http\"\n}}\n"),
                "url",
                "api",
            ),
            8 => (
                format!(
                    "yah 1\nharness \"{label}\" {{\n role = \"builder\"\n open {{ command = [\"pi\"] }}\n}}\n"
                ),
                "kind",
                "harness",
            ),
            9 => (
                format!(
                    "yah 1\nharness \"{label}\" {{\n kind = \"h1\"\n open {{ command = [\"pi\"] }}\n}}\n"
                ),
                "role",
                "harness",
            ),
            10 => (
                format!("yah 1\nharness \"{label}\" {{\n kind = \"h1\"\n role = \"builder\"\n}}\n"),
                "open",
                "harness",
            ),
            11 => (
                format!(
                    "yah 1\nharness \"{label}\" {{\n kind = \"h1\"\n role = \"builder\"\n open {{ cols = 100 }}\n}}\n"
                ),
                "command",
                "harness",
            ),
            12 => (
                format!("yah 1\nteam \"{label}\" {{\n members = [\"a\"]\n}}\n"),
                "root",
                "team",
            ),
            13 => (
                format!("yah 1\nworkflow \"{label}\" {{\n steps = [\"s\"]\n}}\n"),
                "team",
                "workflow",
            ),
            14 => (
                format!(
                    "yah 1\n{}\nteam \"t\" {{\n root = \"alpha\"\n}}\nworkflow \"{label}\" {{\n team = \"t\"\n}}\n",
                    harness_block("alpha")
                ),
                "steps",
                "workflow",
            ),
            15 => (
                format!("yah 1\noutput \"{label}\" {{\n description = \"d\"\n}}\n"),
                "value",
                "output",
            ),
            _ => (
                format!("yah 1\nprovider \"{label}\" {{\n}}\n"),
                "type",
                "provider",
            ),
        };
        let diags = err_diags(&src);
        assert_spans_inside(&diags, &src);
        // A variable with no default is caught one stage earlier, in resolve, as `Missing variable value`; every other kind is schema's `Missing required argument`. Both name the missing field and the block.
        let hit = diags.0.iter().find(|d| (d.summary == "Missing required argument" && d.detail.contains(&format!("\"{field}\""))) || (field == "default" && d.summary == "Missing variable value" && d.detail.contains("no default value"))).unwrap_or_else(|| panic!("case {case}: a missing-field diagnostic naming \"{field}\" is required, got: {diags:?}"));
        if hit.summary == "Missing required argument" {
            assert_eq!(
                hit.detail,
                format!("The argument \"{field}\" is required, but no definition was found."),
                "case {case}: detail must state the field is required"
            );
        }
        let ctx = hit.context.clone().unwrap_or_default();
        assert!(
            ctx.contains(kind),
            "case {case}: context must name the {kind} block, got: {ctx:?}"
        );
    }
}

#[test]
fn secret_shaped_values_never_appear_in_rendered_text() {
    let mut rng = Rng(SEED ^ 0x5EC7);
    for _ in 0..50 {
        let marker = format!(
            "MARKERSECRET{:04}{}",
            rng.below(10000),
            "X".repeat(1 + rng.below(12) as usize)
        );
        let src = format!(
            "yah 1\nprovider \"anthropic\" {{\n type = \"anthropic\"\n api_key = \"{marker}\"\n}}\n"
        );
        let diags = err_diags(&src);
        assert_spans_inside(&diags, &src);
        assert!(
            diags
                .0
                .iter()
                .any(|d| d.summary == "Secrets are never stored"),
            "a literal api_key must be a stored-secret diagnostic, got: {diags:?}"
        );
        let rendered = diags.render(&src);
        assert!(
            !rendered.contains(&marker),
            "the secret value must never appear in rendered text, got: {rendered}"
        );
        assert!(
            rendered.contains("\"***\""),
            "the rendered source line must show the masked form, got: {rendered}"
        );
        assert!(
            !format!("{diags:?}").contains(&marker),
            "the secret value must not be stored in any diagnostic field, got: {diags:?}"
        );
    }
    // Two different secrets in one file are both masked.
    let a = "MARKERSECRETAAAA1111";
    let b = "MARKERSECRETBBBB2222";
    let src = format!(
        "yah 1\nprovider \"one\" {{\n type = \"anthropic\"\n api_key = \"{a}\"\n}}\nprovider \"two\" {{\n type = \"openai\"\n api_key = \"{b}\"\n}}\n"
    );
    let diags = err_diags(&src);
    assert_eq!(
        diags
            .0
            .iter()
            .filter(|d| d.summary == "Secrets are never stored")
            .count(),
        2,
        "both literal keys must be reported, got: {diags:?}"
    );
    let rendered = diags.render(&src);
    assert!(
        !rendered.contains(a) && !rendered.contains(b),
        "neither secret may appear in rendered text, got: {rendered}"
    );
}

#[test]
fn multiple_faults_are_collected_and_valid_sources_still_load() {
    // Controls: an empty file and the canonical fixture must load cleanly, so
    // the rejections above are not simply everything failing.
    load_str("x.yah", "yah 1\n", &BTreeMap::new()).expect("an empty file must load");
    let canonical = include_str!("fixtures/canonical.yah");
    load_str("canonical.yah", canonical, &BTreeMap::new())
        .expect("the canonical fixture must load");
    // Independent faults in different blocks are all reported in one pass.
    let src = "yah 1\nprovider \"p\" {\n}\nmodel \"m\" {\n id = \"m1\"\n}\nsystem_one {\n student = \"s.json\"\n}\noutput \"o\" {\n description = \"d\"\n}\nprovider \"q\" {\n type = \"openai\"\n bogus = 1\n}\n";
    let diags = err_diags(src);
    assert_spans_inside(&diags, src);
    assert!(
        diags.0.len() >= 4,
        "each independent fault must be collected, got: {diags:?}"
    );
    for field in ["type", "provider", "fallback", "value"] {
        assert!(
            diags
                .0
                .iter()
                .any(|d| d.summary == "Missing required argument"
                    && d.detail.contains(&format!("\"{field}\""))),
            "missing \"{field}\" must be reported, got: {diags:?}"
        );
    }
    assert!(
        diags
            .0
            .iter()
            .any(|d| d.summary == "Unsupported argument" && d.detail.contains("\"bogus\"")),
        "the unknown field must be reported, got: {diags:?}"
    );
    let rendered = diags.render(src);
    for field in ["type", "provider", "fallback", "value", "bogus"] {
        assert!(
            rendered.contains(&format!("\"{field}\"")),
            "rendered text must name \"{field}\", got: {rendered}"
        );
    }
}

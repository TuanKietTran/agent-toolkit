//! Parser recovery properties: deterministic mutations of valid sources
//! must never panic the parser, a mutated input that is known to be
//! invalid must never be reported as a successful parse, the number of
//! diagnostics from one parse must stay within the recovery cap, and
//! recovery must not repeat the same diagnostic (same position, length,
//! summary and detail) twice.
//!
//! Deterministic, std only: a fixed-seed xorshift64 generator drives the
//! character deletions, insertions, swaps and truncations applied to the
//! corpus sources. Mutations operate on characters, so every generated
//! input is a valid `&str`.

use std::collections::BTreeSet;
use std::panic::{AssertUnwindSafe, catch_unwind};

use h1::yah::diag::Diagnostics;
use h1::yah::parser::parse;

/// Recovery collects at most this many syntax diagnostics in one parse.
const MAX_DIAGNOSTICS: usize = 20;

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

/// Every diagnostic in an `Err` result must be well formed: at least one
/// and at most the recovery cap, no repeats of the same position and
/// message, and a position inside the mutated source (columns count
/// characters; a diagnostic on the end-of-input position may sit one
/// column past the last character of its line).
fn check_diagnostics(src: &str, diags: &Diagnostics) {
    assert!(
        !diags.0.is_empty(),
        "an error result must carry diagnostics: src={src:?}"
    );
    assert!(
        diags.0.len() <= MAX_DIAGNOSTICS,
        "diagnostic count {} exceeds the recovery cap {MAX_DIAGNOSTICS}: src={src:?} diags={diags:?}",
        diags.0.len()
    );
    let max_line = src.matches('\n').count() as u32 + 1;
    let mut seen: BTreeSet<(u32, u32, u32, String, String)> = BTreeSet::new();
    for d in &diags.0 {
        assert_eq!(
            d.file, "test.yah",
            "diagnostic must name the parsed file: {d:?}"
        );
        assert!(
            d.line >= 1 && d.line <= max_line,
            "diagnostic line {} outside 1..={max_line}: src={src:?} diag={d:?}",
            d.line
        );
        let line_text = src.split('\n').nth((d.line - 1) as usize).unwrap_or("");
        let line_chars = line_text.chars().count() as u32;
        assert!(
            d.col >= 1 && d.col <= line_chars + 1,
            "diagnostic column {} outside its line ({} chars): src={src:?} diag={d:?}",
            d.col,
            line_chars
        );
        let key = (d.line, d.col, d.len, d.summary.clone(), d.detail.clone());
        assert!(
            seen.insert(key),
            "recovery repeated the same diagnostic: src={src:?} diag={d:?}"
        );
    }
}

/// Parse twice under `catch_unwind`: a panic, a disagreement between the
/// two runs, or a malformed diagnostic set all fail the test.
/// Returns true when the input was rejected with diagnostics.
fn check_input(src: &str) -> bool {
    let first = catch_unwind(AssertUnwindSafe(|| parse("test.yah", src)))
        .unwrap_or_else(|_| panic!("parser panicked: src={src:?}"));
    let second = catch_unwind(AssertUnwindSafe(|| parse("test.yah", src)))
        .unwrap_or_else(|_| panic!("parser panicked on a repeat run: src={src:?}"));
    match (first, second) {
        (Ok(_), Ok(_)) => false,
        (Err(diags), Err(again)) => {
            assert_eq!(
                diags, again,
                "parsing the same input must give the same diagnostics: src={src:?}"
            );
            check_diagnostics(src, &diags);
            true
        }
        (first, second) => panic!(
            "the same input parsed inconsistently: src={src:?} first_ok={} second_ok={}",
            first.is_ok(),
            second.is_ok()
        ),
    }
}

fn assert_invalid(label: &str, src: &str) {
    assert!(
        check_input(src),
        "{label}: an invalid input must not parse successfully: src={src:?}"
    );
}

#[test]
fn mutated_corpus_never_panics_and_diagnostics_stay_well_formed() {
    const INSERTABLE: &[char] = &[
        '{', '}', '[', ']', '=', '\"', '`', '@', '#', '$', ',', '.', '\n', ' ', 'a', '1',
    ];
    let mut rng = Rng(SEED);
    let mut exercised = 0usize;
    let mut rejected = 0usize;
    for (name, src) in sources() {
        assert!(
            parse("test.yah", src).is_ok(),
            "corpus source {name} must itself parse"
        );
        let chars: Vec<char> = src.chars().collect();
        // Character deletions.
        for _ in 0..160 {
            let at = rng.below(chars.len());
            let mutated: String = chars
                .iter()
                .enumerate()
                .filter(|(i, _)| *i != at)
                .map(|(_, c)| c)
                .collect();
            exercised += 1;
            if check_input(&mutated) {
                rejected += 1;
            }
        }
        // Character insertions.
        for _ in 0..160 {
            let at = rng.below(chars.len() + 1);
            let c = INSERTABLE[rng.below(INSERTABLE.len())];
            let mut owned: Vec<char> = chars.clone();
            owned.insert(at, c);
            let mutated: String = owned.iter().collect();
            exercised += 1;
            if check_input(&mutated) {
                rejected += 1;
            }
        }
        // Adjacent character swaps.
        for _ in 0..80 {
            let at = rng.below(chars.len() - 1);
            if chars[at] == chars[at + 1] {
                continue;
            }
            let mut owned: Vec<char> = chars.clone();
            owned.swap(at, at + 1);
            let mutated: String = owned.iter().collect();
            exercised += 1;
            if check_input(&mutated) {
                rejected += 1;
            }
        }
        // Truncations at a character boundary.
        for _ in 0..80 {
            let at = rng.below(chars.len());
            let mutated: String = chars.iter().take(at).collect();
            exercised += 1;
            if check_input(&mutated) {
                rejected += 1;
            }
        }
    }
    assert!(
        exercised >= 2000,
        "mutation corpus too small: {exercised} inputs"
    );
    assert!(
        rejected >= 200,
        "mutation corpus must exercise recovery, only {rejected} of {exercised} inputs were rejected"
    );
}

#[test]
fn known_invalid_mutations_are_never_reported_as_success() {
    let base = "yah 1\nname = \"demo\"\nitems = [1, 2]\nblock {\n  key = 1\n  label = \"x\"\n}\n";
    assert!(
        parse("test.yah", base).is_ok(),
        "the unmutated base source must parse: {base:?}"
    );
    let remove_at = |src: &str, byte: usize| -> String {
        let mut owned = src.to_string();
        owned.remove(byte);
        owned
    };
    // Deleting a structural character breaks the source.
    assert_invalid(
        "deleted assignment equals",
        &remove_at(base, base.find('=').unwrap()),
    );
    let first_quote = base.find('\"').unwrap();
    let second_quote = base[first_quote + 1..].find('\"').unwrap() + first_quote + 1;
    assert_invalid("deleted closing quote", &remove_at(base, second_quote));
    assert_invalid(
        "deleted list opener",
        &remove_at(base, base.find('[').unwrap()),
    );
    assert_invalid(
        "deleted list closer",
        &remove_at(base, base.find(']').unwrap()),
    );
    assert_invalid(
        "deleted block opener",
        &remove_at(base, base.find('{').unwrap()),
    );
    assert_invalid(
        "deleted block closer",
        &remove_at(base, base.rfind('}').unwrap()),
    );
    // A stray closer or a stray character after the last statement.
    assert_invalid("appended stray closer", &format!("{base}}}\n"));
    assert_invalid("appended stray character", &format!("{base}@\n"));
    // Damaging the header: swapped letters or an unsupported version.
    assert_invalid("swapped header letters", &format!("ayh{}", &base[3..]));
    assert_invalid("unsupported version", &base.replacen("yah 1", "yah 2", 1));
    // Truncating in the middle of a block: drop the closing brace.
    let unclosed = &base[..base.rfind('}').unwrap()];
    assert_invalid("truncated inside a block", unclosed);
    // The same classes of damage applied to every corpus source.
    for (name, src) in sources() {
        let version_digit = src
            .find("yah ")
            .unwrap_or_else(|| panic!("{name} must start with a yah header"))
            + 4;
        assert_invalid("deleted version digit", &remove_at(src, version_digit));
        assert_invalid(
            "deleted assignment equals",
            &remove_at(src, src.find('=').unwrap()),
        );
        assert_invalid("appended stray closer", &format!("{src}}}\n"));
        assert_invalid("appended stray character", &format!("{src}@\n"));
    }
}

#[test]
fn diagnostic_count_stays_within_the_recovery_cap() {
    // Far more bad statements than the cap: exactly the cap is reported.
    let mut src = String::from("yah 1\n");
    for i in 0..30 {
        src.push_str(&format!("k{i} = = {i}\n"));
    }
    let diags = parse("test.yah", &src).unwrap_err();
    assert_eq!(diags.0.len(), MAX_DIAGNOSTICS, "{diags:?}");
    check_diagnostics(&src, &diags);
    // Truncating that input at any point must also stay within the cap.
    let chars: Vec<char> = src.chars().collect();
    for take in (0..=chars.len()).step_by(7) {
        let truncated: String = chars.iter().take(take).collect();
        check_input(&truncated);
    }
}

#[test]
fn recovery_does_not_repeat_the_same_diagnostic() {
    // A bad value inside a block that is then left unclosed used to be a
    // duplicate risk: the value error and the unclosed-block error are
    // different problems and each may appear only once.
    let src = "yah 1\nblk {\n  a = = 1\n";
    let diags = parse("test.yah", src).unwrap_err();
    check_diagnostics(src, &diags);
    // The same bad statement on different lines is a different diagnostic
    // per line, never a repeat of one position.
    let src = "yah 1\na = = 1\nb = = 2\nc = = 4\n";
    let diags = parse("test.yah", src).unwrap_err();
    assert_eq!(diags.0.len(), 3, "{diags:?}");
    check_diagnostics(src, &diags);
}

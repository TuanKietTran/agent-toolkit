//! Parser robustness: adversarial inputs must never panic the front end.
//!
//! Corpus (deterministic, fixed-seed xorshift64, std only):
//! (a) fully random byte strings, including invalid UTF-8,
//! (b) prefix truncations of the canonical fixture and every example
//!     (every byte offset for the smallest file, sampled for larger ones),
//! (c) random single-byte mutations of those valid files.
//! Every input goes through `h1::yah::load::load_file` — the exact entry
//! path the CLI uses — written as raw bytes to a temp file, so invalid UTF-8
//! is exercised as the loader's normal read error, never a lossy shortcut.
//! Ok and diagnostic Err are both acceptable outcomes; a panic is not.
//! `std::panic::catch_unwind` per input keeps one bad input from killing
//! the run, and the failure report names the input kind, index, and offset.

use std::collections::BTreeMap;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::PathBuf;

use h1::yah::load::load_file;

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
    fn byte(&mut self) -> u8 {
        (self.next_u64() & 0xFF) as u8
    }
}

fn sources() -> Vec<(&'static str, &'static [u8])> {
    vec![
        ("canonical.yah", include_bytes!("fixtures/canonical.yah")),
        ("demo.yah", include_bytes!("../examples/demo.yah")),
        ("team.yah", include_bytes!("../examples/team.yah")),
        (
            "research-team.yah",
            include_bytes!("../examples/research-team.yah"),
        ),
    ]
}

fn panic_text(payload: &(dyn std::any::Any + Send)) -> String {
    if let Some(s) = payload.downcast_ref::<&str>() {
        (*s).to_string()
    } else if let Some(s) = payload.downcast_ref::<String>() {
        s.clone()
    } else {
        "<non-string panic payload>".to_string()
    }
}

#[test]
fn parser_never_panics_on_adversarial_corpus() {
    let dir: PathBuf =
        std::env::temp_dir().join(format!("gl-parser-robustness-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("create corpus temp dir");
    let path = dir.join("input.yah");
    let overrides: BTreeMap<String, String> = BTreeMap::new();

    let mut rng = Rng(SEED);
    let mut count: usize = 0;
    let mut failures: Vec<String> = Vec::new();

    let run = |kind: &str,
               index: usize,
               offset: usize,
               bytes: &[u8],
               rng_state: u64,
               count: &mut usize,
               failures: &mut Vec<String>| {
        *count += 1;
        std::fs::write(&path, bytes).expect("write corpus input");
        let result = catch_unwind(AssertUnwindSafe(|| load_file(&path, &overrides)));
        if let Err(payload) = result {
            failures.push(format!(
                "{kind} input #{index} (offset {offset}, {} bytes, rng state {rng_state:#x}): panic: {}",
                bytes.len(),
                panic_text(&*payload)
            ));
        }
    };

    // (a) Fully random byte strings, lengths 0..=512, any byte values.
    for i in 0..400 {
        let state = rng.0;
        let len = rng.below(513);
        let bytes: Vec<u8> = (0..len).map(|_| rng.byte()).collect();
        run("random", i, len, &bytes, state, &mut count, &mut failures);
    }

    let srcs = sources();
    let smallest = srcs.iter().map(|(_, b)| b.len()).min().unwrap();

    // (b) Prefix truncations: every byte offset for the smallest file,
    //     every 7th byte (plus the full length) for larger files.
    for (name, bytes) in &srcs {
        let step = if bytes.len() == smallest { 1 } else { 7 };
        let mut cuts: Vec<usize> = (0..=bytes.len()).step_by(step).collect();
        if cuts.last() != Some(&bytes.len()) {
            cuts.push(bytes.len());
        }
        for (i, cut) in cuts.iter().enumerate() {
            run(
                &format!("truncate:{name}"),
                i,
                *cut,
                &bytes[..*cut],
                SEED,
                &mut count,
                &mut failures,
            );
        }
    }

    // (c) Random single-byte mutations of each valid file.
    for (name, bytes) in &srcs {
        for i in 0..300 {
            let state = rng.0;
            let offset = rng.below(bytes.len());
            let mut mutated = bytes.to_vec();
            let mut b = rng.byte();
            if b == mutated[offset] {
                b = b.wrapping_add(1);
            }
            mutated[offset] = b;
            run(
                &format!("mutate:{name}"),
                i,
                offset,
                &mutated,
                state,
                &mut count,
                &mut failures,
            );
        }
    }

    let _ = std::fs::remove_dir_all(&dir);
    println!(
        "parser_robustness corpus: {count} inputs exercised, {} panics",
        failures.len()
    );
    assert!(count >= 1000, "corpus too small: {count} inputs");
    assert!(
        failures.is_empty(),
        "front end panicked on {} input(s):\n{}",
        failures.len(),
        failures[..failures.len().min(10)].join("\n")
    );
}

#[test]
fn valid_sources_still_load() {
    // Sanity anchor: the corpus files themselves are valid inputs, so a
    // green robustness run cannot be an artefact of everything erroring.
    let overrides: BTreeMap<String, String> = BTreeMap::new();
    let src = include_str!("fixtures/canonical.yah");
    let spec = h1::yah::load::load_str("canonical.yah", src, &overrides).expect("canonical loads");
    assert_eq!(spec.version, 1);
}

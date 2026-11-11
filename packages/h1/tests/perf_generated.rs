//! H14 perf guard: a deterministic ~3000-line .yah generated in a temp
//! dir at test time (no fixture committed), timed through the in-process
//! pipeline the CLI `plan` command uses: `load::load_file` (the cli
//! `load_spec` step: parse + resolve + schema) -> `pick::resolve_all`
//! -> `plan::build`. Asserts the whole pipeline stays under 1000 ms on
//! this machine and prints the measured ms.
//!
//! Exact composition of the generated file (2997 lines):
//! - preamble, 21 lines: `yah 1`, one `defaults` block, one `provider`
//!   block, two `model` blocks (sonnet, haiku), one `system_one` block
//!   (fallback = haiku).
//! - 250 `variable` blocks x 4 lines = 1000 lines (v000..v249, string
//!   defaults `value-NNN`).
//! - 40 `vault` blocks x 8 lines = 320 lines (vault00..vault39, dotenv,
//!   2 declared secrets each: KEY000..KEY079, value = key name).
//! - 118 `harness` blocks = 1651 lines: the root h000 is 13 lines, the
//!   117 members are 14 lines each (extra `parent = "h000"` line).
//!   Every harness is kind h1 / role cycling worker|researcher|
//!   reviewer|planner; every third harness uses `model = "system-one"`
//!   (answered by the stub picker below, never a subprocess), the rest
//!   are pinned to `haiku`. Each command interpolates `${var.vNNN}`
//!   and its own `${harnesses.hNNN.model_id}`, `cwd` is a bare
//!   `var.vNNN` reference, and the env map carries one
//!   `${vault.vaultNN.KEYNNN}` reference (env-only, per the vault
//!   rules) plus one `${var.vNNN}` reference, rotated across all
//!   40 vaults and 250 variables so references spread over the file.
//! - one `team` block, 5 lines: root h000, members h001..h117.

use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::time::Instant;

use h1::yah::load::load_file;
use h1::yah::pick::{PickDecision, PickRequest, Picker, resolve_all};
use h1::yah::plan::{PlanOpts, build};

/// Deterministic picker for the `system-one` harnesses: always chooses
/// the haiku catalog entry, in-process, so the timing measures
/// graphloop itself and never a system-one subprocess.
struct StubPicker;

impl Picker for StubPicker {
    fn pick(&self, _request: &PickRequest) -> anyhow::Result<PickDecision> {
        Ok(PickDecision {
            model_id: "claude-haiku-5-5".to_string(),
            rule: "perf-stub".to_string(),
            reason: "perf guard stub picker".to_string(),
            degraded_level: 0,
        })
    }
}

fn generate() -> String {
    let mut s = String::new();
    s.push_str("yah 1\n");
    s.push_str("defaults {\n  model_policy = \"system-one\"\n  sandbox = \"local\"\n}\n");
    s.push_str("provider \"anthropic\" {\n  type = \"anthropic\"\n}\n");
    for (label, id, caps) in [
        (
            "sonnet",
            "claude-sonnet-5-5",
            "[\"chat\", \"tools\", \"vision\"]",
        ),
        ("haiku", "claude-haiku-5-5", "[\"chat\", \"tools\"]"),
    ] {
        let _ = write!(
            s,
            "model \"{label}\" {{\n  provider = \"anthropic\"\n  id = \"{id}\"\n  capabilities = {caps}\n}}\n"
        );
    }
    s.push_str("system_one {\n  fallback = \"haiku\"\n}\n");

    for i in 0..250 {
        let _ = write!(
            s,
            "variable \"v{i:03}\" {{\n  type = \"string\"\n  default = \"value-{i:03}\"\n}}\n"
        );
    }

    for j in 0..40 {
        let _ = write!(
            s,
            "vault \"vault{j:02}\" {{\n  provider = \"dotenv\"\n  path = \"vault{j:02}.env\"\n  secrets = {{\n    KEY{:03} = \"KEY{:03}\"\n    KEY{:03} = \"KEY{:03}\"\n  }}\n}}\n",
            j * 2,
            j * 2,
            j * 2 + 1,
            j * 2 + 1
        );
    }

    let roles = ["worker", "researcher", "reviewer", "planner"];
    for i in 0..118 {
        let model = if i % 3 == 0 { "system-one" } else { "haiku" };
        let _ = write!(
            s,
            "harness \"h{i:03}\" {{\n  kind = \"h1\"\n  role = \"{}\"\n  model = \"{model}\"\n",
            roles[i % roles.len()]
        );
        if i > 0 {
            s.push_str("  parent = \"h000\"\n");
        }
        let vault = i % 40;
        let _ = write!(
            s,
            "  open {{\n    command = [\"cat\", \"${{var.v{:03}}}\", \"${{harnesses.h{i:03}.model_id}}\"]\n    cwd = var.v{:03}\n    env = {{\n      TOKEN = \"${{vault.vault{vault:02}.KEY{:03}}}\"\n      WORK = \"${{var.v{:03}}}\"\n    }}\n  }}\n}}\n",
            i % 250,
            (i * 3) % 250,
            vault * 2,
            (i * 7) % 250
        );
    }

    let members: Vec<String> = (1..118).map(|i| format!("\"h{i:03}\"")).collect();
    let _ = write!(
        s,
        "team \"perf\" {{\n  root = \"h000\"\n  members = [{}]\n  graph = true\n}}\n",
        members.join(", ")
    );
    s
}

#[test]
fn generated_3000_line_file_loads_and_plans_under_1000ms() {
    let src = generate();
    let lines = src.lines().count();
    assert!(
        (2900..=3100).contains(&lines),
        "generated file must be ~3000 lines, got {lines}"
    );

    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("perf_generated.yah");
    std::fs::write(&path, &src).unwrap();

    let start = Instant::now();
    let spec = load_file(&path, &BTreeMap::new()).expect("generated file must load");
    let resolved = resolve_all(&spec, &StubPicker).expect("generated file must resolve models");
    let opts = PlanOpts {
        prefix: Some("perf".to_string()),
        run: "perf".to_string(),
        trace_dir: None,
        detached: false,
    };
    let plan = build(&spec, "perf", &resolved, &opts).expect("generated file must plan");
    let elapsed = start.elapsed();

    assert_eq!(spec.variables.len(), 250);
    assert_eq!(spec.vaults.len(), 40);
    assert_eq!(spec.harnesses.len(), 118);
    assert_eq!(resolved.len(), 118);
    assert_eq!(plan.steps.len(), 118);

    println!(
        "perf_generated: {lines} lines, load+resolve+plan in {} ms",
        elapsed.as_millis()
    );
    assert!(
        elapsed.as_millis() < 1000,
        "load+resolve+plan took {} ms, over the 1000 ms guard",
        elapsed.as_millis()
    );
}

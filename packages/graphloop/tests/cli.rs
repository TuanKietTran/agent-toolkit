//! Integration tests for the graphloop CLI cores.
//!
//! The cores are driven with a hand-built `Plan`/`Resolved` and a fake
//! `h1`: a small sh script that logs its argv, answers `list --json`
//! from a fixture, and can be told to fail one open/stop by session name.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use graphloop::cli::*;
use graphloop::manifest::{Edge, EdgeKind, Manifest, Node, PickInfo};
use graphloop::pick::{Resolved, Via};
use graphloop::plan::{OpenStep, Plan};
use graphloop::spec::{Part, Team, Templ};

fn t(s: &str) -> Templ { Templ::lit(s) }

fn commander_step() -> OpenStep {
    OpenStep { harness: "commander".into(), name: "commander".into(), role: "commander".into(), parent: None, model: "anthropic/claude-sonnet-5-5".into(), argv: vec![t("open"), t("-n"), t("commander"), t("--role"), t("commander"), t("--model"), t("anthropic/claude-sonnet-5-5"), t("--"), t("pi"), t("--no-session")] }
}

fn builder_step() -> OpenStep {
    OpenStep { harness: "builder".into(), name: "builder".into(), role: "builder".into(), parent: Some("commander".into()), model: "anthropic/claude-sonnet-5-5".into(), argv: vec![t("open"), t("-n"), t("builder"), t("--role"), t("builder"), t("--parent"), t("commander"), t("--model"), t("anthropic/claude-sonnet-5-5"), t("--"), t("pi"), Templ(vec![Part::Lit("API_KEY=".into()), Part::Env("GL_TEST_KEY".into())])] }
}

fn sample_plan() -> Plan {
    Plan { team: "default".into(), root: "commander".into(), steps: vec![commander_step(), builder_step()], edges: vec![Edge { from: "commander".into(), to: "builder".into(), kind: EdgeKind::Parent }, Edge { from: "commander".into(), to: "builder".into(), kind: EdgeKind::Member }] }
}

fn sample_resolved() -> Vec<Resolved> {
    vec![
        Resolved { harness: "commander".into(), requested: "system-one".into(), label: "sonnet".into(), id: "claude-sonnet-5-5".into(), provider_type: "anthropic".into(), via: Via::SystemOne, rule: Some("R3".into()), reason: "strict constraints".into(), degraded_level: 0 },
        Resolved { harness: "builder".into(), requested: "system-one".into(), label: "sonnet".into(), id: "claude-sonnet-5-5".into(), provider_type: "anthropic".into(), via: Via::Fallback, rule: None, reason: "system-one unavailable".into(), degraded_level: 1 },
    ]
}

fn sample_nodes() -> Vec<Node> {
    vec![
        Node { name: "commander".into(), harness: "commander".into(), role: "commander".into(), parent: None, requested_model: "system-one".into(), model: "anthropic/claude-sonnet-5-5".into(), model_label: "sonnet".into(), pick: PickInfo { via: "system-one".into(), rule: Some("R3".into()), reason: "strict constraints".into(), degraded_level: 0 }, tools: vec!["fs".into()], vault_env: vec![] },
        Node { name: "builder".into(), harness: "builder".into(), role: "builder".into(), parent: Some("commander".into()), requested_model: "system-one".into(), model: "anthropic/claude-sonnet-5-5".into(), model_label: "sonnet".into(), pick: PickInfo { via: "fallback".into(), rule: None, reason: "system-one unavailable".into(), degraded_level: 1 }, tools: vec![], vault_env: vec![] },
    ]
}

fn sample_team() -> Team {
    Team { name: "default".into(), root: "commander".into(), members: vec!["commander".into(), "builder".into()], graph: true, line: 1 }
}

fn sample_manifest(run: &str, created_ms: u64, trace_dir: Option<String>) -> Manifest {
    Manifest { version: 1, run: run.into(), team: "default".into(), source: "/tmp/team.yah".into(), root: "commander".into(), created_ms, trace_dir, nodes: sample_nodes(), edges: vec![Edge { from: "commander".into(), to: "builder".into(), kind: EdgeKind::Parent }] }
}

const RUN: &str = "default-1700000000-ab12";
const NOW_MS: u64 = 1_700_000_000_000;

/// Write the fake `h1` script into `dir`; returns (bin, argv log).
fn make_fake(dir: &Path, list_json: &str, fail_open: &str, fail_stop: &str) -> (PathBuf, PathBuf) {
    use std::os::unix::fs::PermissionsExt;
    let fixture = dir.join("list.json");
    std::fs::write(&fixture, list_json).unwrap();
    let log = dir.join("calls.log");
    let bin = dir.join("h1");
    let script = format!("#!/bin/sh\necho \"$@\" >> \"{log}\"\ncase \"$1\" in\nlist) cat \"{fixture}\" ;;\nconsole) echo \"FAKE GRAPH SNAPSHOT\" ;;\nopen) for a in \"$@\"; do if [ \"$a\" = \"{fail_open}\" ]; then echo \"fake open failure\" >&2; exit 3; fi; done; exit 0 ;;\nstop) for a in \"$@\"; do if [ \"$a\" = \"{fail_stop}\" ]; then exit 4; fi; done; exit 0 ;;\nesac\nexit 0\n", log = log.display(), fixture = fixture.display());
    std::fs::write(&bin, script).unwrap();
    std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
    (bin, log)
}

fn calls(log: &Path) -> Vec<String> {
    std::fs::read_to_string(log).map(|s| s.lines().map(|l| l.to_string()).collect()).unwrap_or_default()
}

fn open_calls(log: &Path) -> Vec<String> {
    calls(log).into_iter().filter(|l| l.starts_with("open ")).collect()
}

fn up_req<'a>(plan: &'a Plan, home: &Path, manifest_dir: &Path, env: &'a dyn Fn(&str) -> Option<String>) -> UpRequest<'a> {
    UpRequest { plan, nodes: sample_nodes(), source: "/tmp/team.yah".into(), home: home.to_path_buf(), manifest_dir: manifest_dir.to_path_buf(), run: RUN.into(), now_ms: NOW_MS, env, vault: &no_vault }
}

fn up_req_full<'a>(plan: &'a Plan, home: &Path, manifest_dir: &Path, env: &'a dyn Fn(&str) -> Option<String>, vault: &'a dyn Fn(&str, &str) -> Result<String, String>) -> UpRequest<'a> {
    UpRequest { plan, nodes: sample_nodes(), source: "/tmp/team.yah".into(), home: home.to_path_buf(), manifest_dir: manifest_dir.to_path_buf(), run: RUN.into(), now_ms: NOW_MS, env, vault }
}

fn good_vault(vault: &str, key: &str) -> Result<String, String> {
    if vault == "local" && key == "FLEET_TOKEN" { Ok("s3cr3t-token-9f2a".into()) } else { Err(format!("unknown vault key {vault}.{key}")) }
}

fn dry_plan() -> Plan {
    let mut plan = sample_plan();
    plan.steps[1].argv = vec![t("open"), t("-n"), t("builder"), t("--role"), t("builder"), t("--parent"), t("commander"), t("--model"), t("anthropic/claude-sonnet-5-5"), t("--env"), Templ(vec![Part::Lit("FLEET_TOKEN=".into()), Part::Vault("local".into(), "FLEET_TOKEN".into())]), t("--env"), Templ(vec![Part::Lit("API_KEY=".into()), Part::Env("GL_TEST_KEY".into())]), t("--"), t("cat")];
    plan
}

fn no_vault(_: &str, _: &str) -> Result<String, String> {
    Err("no vault".to_owned())
}

fn good_env(name: &str) -> Option<String> {
    if name == "GL_TEST_KEY" { Some("test-value".into()) } else { None }
}

#[test]
fn plan_text_comment_and_shell_per_step() {
    let out = plan_output(&sample_plan(), &sample_resolved());
    assert!(out.contains("# harness commander: anthropic/claude-sonnet-5-5 (via system-one R3: strict constraints)"), "{out}");
    assert!(out.contains("# harness builder: anthropic/claude-sonnet-5-5 (via fallback: system-one unavailable)"), "{out}");
    assert!(out.contains("h1 open -n commander --role commander --model anthropic/claude-sonnet-5-5 -- pi --no-session"), "{out}");
    assert!(out.contains("h1 open -n builder --role builder --parent commander --model anthropic/claude-sonnet-5-5 -- pi API_KEY=${env.GL_TEST_KEY}"), "{out}");
}

#[test]
fn plan_text_never_expands_env() {
    let out = plan_output(&sample_plan(), &sample_resolved());
    assert!(out.contains("${env.GL_TEST_KEY}"));
    assert!(!out.contains("test-value"));
}

#[test]
fn plan_text_without_resolution_omits_provenance() {
    let out = plan_output(&sample_plan(), &[]);
    assert!(out.contains("# harness commander: anthropic/claude-sonnet-5-5\n"), "{out}");
}

#[test]
fn plan_json_shape() {
    let v = plan_json(&sample_plan(), &sample_resolved());
    assert_eq!(v["team"], "default");
    assert_eq!(v["root"], "commander");
    let steps = v["steps"].as_array().unwrap();
    assert_eq!(steps.len(), 2);
    assert_eq!(steps[0]["harness"], "commander");
    assert_eq!(steps[0]["name"], "commander");
    assert_eq!(steps[0]["parent"], serde_json::Value::Null);
    assert_eq!(steps[1]["parent"], "commander");
    assert_eq!(steps[0]["via"], "system-one");
    assert_eq!(steps[0]["rule"], "R3");
    assert_eq!(steps[0]["reason"], "strict constraints");
    assert_eq!(steps[1]["via"], "fallback");
    assert_eq!(steps[1]["rule"], serde_json::Value::Null);
    let argv = steps[1]["argv"].as_array().unwrap();
    assert_eq!(argv.last().unwrap(), "API_KEY=${env.GL_TEST_KEY}");
    assert_eq!(v["edges"][0]["kind"], "parent");
    assert_eq!(v["edges"][1]["kind"], "member");
}

#[test]
fn graph_text_tree_provenance_and_member_edges() {
    let out = graph_output(&sample_team(), &sample_plan(), &sample_resolved());
    assert!(out.starts_with("team default (root commander)\n"), "{out}");
    assert!(out.contains("commander  [commander]  anthropic/claude-sonnet-5-5  (system-one R3)"), "{out}");
    assert!(out.contains("\u{2514}\u{2500}\u{25b6} builder  [builder]  anthropic/claude-sonnet-5-5  (fallback)"), "{out}");
    assert!(out.contains("member edges:\ncommander -> builder (member)"), "{out}");
}

#[test]
fn graph_text_no_member_edges_no_section() {
    let mut plan = sample_plan();
    plan.edges.retain(|e| e.kind == EdgeKind::Parent);
    let out = graph_output(&sample_team(), &plan, &sample_resolved());
    assert!(!out.contains("member edges"), "{out}");
}

#[test]
fn shell_line_quotes_args_with_spaces() {
    let mut step = commander_step();
    step.argv.push(t("hello world"));
    let out = shell_line(&step);
    assert!(out.ends_with("'hello world'"), "{out}");
}

#[test]
fn build_nodes_uses_resolved_and_tools() {
    use graphloop::spec::{Harness, ModelRef, Open};
    let harnesses = vec![
        Harness { name: "commander".into(), kind: "h1".into(), role: "commander".into(), parent: None, model: ModelRef::SystemOne, tools: vec!["fs".into()], complexity: None, open: Open::default(), line: 1 },
        Harness { name: "builder".into(), kind: "h1".into(), role: "builder".into(), parent: Some("commander".into()), model: ModelRef::SystemOne, tools: vec![], complexity: None, open: Open::default(), line: 9 },
    ];
    let nodes = build_nodes(&harnesses, &sample_plan(), &sample_resolved()).unwrap();
    assert_eq!(nodes.len(), 2);
    assert_eq!(nodes[0].tools, vec!["fs".to_string()]);
    assert_eq!(nodes[0].requested_model, "system-one");
    assert_eq!(nodes[0].model_label, "sonnet");
    assert_eq!(nodes[0].pick.via, "system-one");
    assert_eq!(nodes[1].pick.via, "fallback");
    assert_eq!(nodes[1].parent.as_deref(), Some("commander"));
}

#[test]
fn build_nodes_missing_resolution_errors() {
    let e = build_nodes(&[], &sample_plan(), &[]).unwrap_err();
    assert!(e.contains("commander"), "{e}");
}

#[test]
fn build_manifest_fields() {
    let dir = tempfile::tempdir().unwrap();
    let trace = dir.path().join("trace");
    let m = build_manifest(&sample_plan(), sample_nodes(), "/tmp/team.yah", RUN, &trace, NOW_MS);
    assert_eq!(m.version, 1);
    assert_eq!(m.run, RUN);
    assert_eq!(m.team, "default");
    assert_eq!(m.root, "commander");
    assert_eq!(m.created_ms, NOW_MS);
    assert_eq!(m.trace_dir.as_deref(), Some(trace.to_str().unwrap()));
    assert_eq!(m.nodes.len(), 2);
    assert_eq!(m.edges.len(), 2);
}

#[test]
fn manifest_for_source_picks_newest() {
    let older = sample_manifest("r-old", 100, None);
    let mut newer = sample_manifest("r-new", 200, None);
    newer.source = "/tmp/team.yah".into();
    let other = sample_manifest("r-other", 300, None);
    let mut other = other;
    other.source = "/tmp/other.yah".into();
    let all = vec![older, newer, other];
    assert_eq!(manifest_for_source(&all, "/tmp/team.yah").unwrap().run, "r-new");
    assert!(manifest_for_source(&all, "/tmp/none.yah").is_none());
}

#[cfg(unix)]
#[test]
fn up_opens_in_order_writes_manifest_and_reports() {
    let dir = tempfile::tempdir().unwrap();
    let (bin, log) = make_fake(dir.path(), "[]", "__none__", "__none__");
    let runner = ProcessRunner { bin };
    let plan = sample_plan();
    let home = dir.path().join("home");
    let mdir = dir.path().join("graphs");
    let out = up_core(&up_req(&plan, &home, &mdir, &good_env), &runner).unwrap();
    assert_eq!(out.run, RUN);
    let opens = open_calls(&log);
    assert_eq!(opens.len(), 2, "{opens:?}");
    assert_eq!(opens[0], "open -n commander --role commander --model anthropic/claude-sonnet-5-5 -- pi --no-session");
    assert_eq!(opens[1], "open -n builder --role builder --parent commander --model anthropic/claude-sonnet-5-5 -- pi API_KEY=test-value");
    assert!(out.manifest_path.exists(), "manifest written");
    let text = std::fs::read_to_string(&out.manifest_path).unwrap();
    assert!(text.contains("\"commander\""), "{text}");
    assert!(!text.contains("test-value"), "manifest must not contain expanded env: {text}");
    assert!(out.run_dir.join("run.json").exists(), "run.json copy");
    assert!(!out.run_dir.join("open-commander.log").exists(), "open log deleted on success");
    assert!(out.output.contains(&format!("up: {RUN} (2 labs)")), "{}", out.output);
    assert!(out.output.contains("FAKE GRAPH SNAPSHOT"), "{}", out.output);
    assert!(out.output.contains("h1 console"), "{}", out.output);
    assert!(out.output.contains(&format!("graphloop down --run {RUN}")), "{}", out.output);
}

#[cfg(unix)]
#[test]
fn up_collision_refused_before_opening() {
    let dir = tempfile::tempdir().unwrap();
    let (bin, log) = make_fake(dir.path(), "[{\"name\":\"builder\",\"state\":\"up\"}]", "__none__", "__none__");
    let runner = ProcessRunner { bin };
    let plan = sample_plan();
    let home = dir.path().join("home");
    let mdir = dir.path().join("graphs");
    let e = up_core(&up_req(&plan, &home, &mdir, &good_env), &runner).unwrap_err();
    assert!(e.contains("builder"), "{e}");
    assert!(e.contains("already running"), "{e}");
    assert!(open_calls(&log).is_empty(), "nothing opened");
    assert!(!mdir.join(format!("{RUN}.json")).exists(), "no manifest");
}

#[cfg(unix)]
#[test]
fn up_missing_env_refused_before_opening() {
    let dir = tempfile::tempdir().unwrap();
    let (bin, log) = make_fake(dir.path(), "[]", "__none__", "__none__");
    let runner = ProcessRunner { bin };
    let plan = sample_plan();
    let home = dir.path().join("home");
    let mdir = dir.path().join("graphs");
    let no_env = |_: &str| None;
    let e = up_core(&up_req(&plan, &home, &mdir, &no_env), &runner).unwrap_err();
    assert!(e.contains("GL_TEST_KEY"), "{e}");
    assert!(open_calls(&log).is_empty(), "nothing opened");
    assert!(!mdir.join(format!("{RUN}.json")).exists(), "no manifest");
    assert!(!home.join("runs").join(RUN).exists(), "no run dir");
}

#[test]
fn dry_run_prints_env_names_only_and_creates_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let plan = dry_plan();
    let home = dir.path().join("home");
    let mdir = dir.path().join("graphs");
    let out = up_dry_run_core(&up_req_full(&plan, &home, &mdir, &good_env, &good_vault)).unwrap();
    assert!(out.contains("dry-run: 2 labs"), "{out}");
    assert!(out.contains("commander: model anthropic/claude-sonnet-5-5 via system-one, env -\n"), "{out}");
    assert!(out.contains("builder: model anthropic/claude-sonnet-5-5 via fallback, env API_KEY, FLEET_TOKEN (vault)\n"), "{out}");
    assert!(!out.contains("s3cr3t-token-9f2a"), "{out}");
    assert!(!out.contains("test-value"), "{out}");
    assert!(!home.exists(), "no run dir");
    assert!(!mdir.exists(), "no manifest dir");
}

#[test]
fn dry_run_missing_secret_fails_like_up_and_creates_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let plan = dry_plan();
    let home = dir.path().join("home");
    let mdir = dir.path().join("graphs");
    let e = up_dry_run_core(&up_req_full(&plan, &home, &mdir, &good_env, &no_vault)).unwrap_err();
    assert!(e.contains("builder"), "{e}");
    assert!(!home.exists());
    assert!(!mdir.exists());
    let no_env = |_: &str| None;
    let e = up_dry_run_core(&up_req_full(&plan, &home, &mdir, &no_env, &good_vault)).unwrap_err();
    assert!(e.contains("GL_TEST_KEY"), "{e}");
}

#[test]
fn process_up_help_lists_dry_run() {
    let out = std::process::Command::new(env!("CARGO_BIN_EXE_graphloop")).args(["up", "--help"]).output().unwrap();
    assert!(out.status.success());
    let text = String::from_utf8_lossy(&out.stdout);
    assert!(text.contains("--dry-run"), "{text}");
}

#[cfg(unix)]
#[test]
fn up_second_open_failure_stops_first_and_removes_manifest() {
    let dir = tempfile::tempdir().unwrap();
    let (bin, log) = make_fake(dir.path(), "[]", "builder", "__none__");
    let runner = ProcessRunner { bin };
    let plan = sample_plan();
    let home = dir.path().join("home");
    let mdir = dir.path().join("graphs");
    let e = up_core(&up_req(&plan, &home, &mdir, &good_env), &runner).unwrap_err();
    assert!(e.contains("builder"), "{e}");
    let all = calls(&log);
    let stops: Vec<&String> = all.iter().filter(|l| l.starts_with("stop ")).collect();
    assert_eq!(stops.len(), 1, "{all:?}");
    assert_eq!(stops[0], "stop -n commander");
    assert!(!mdir.join(format!("{RUN}.json")).exists(), "manifest removed");
    let run_dir = home.join("runs").join(RUN);
    assert!(run_dir.exists(), "run dir kept");
    assert!(run_dir.join("error.log").exists(), "error log kept");
}

#[cfg(unix)]
fn up_then(dir: &Path, fail_stop: &str) -> (ProcessRunner, PathBuf, PathBuf, PathBuf) {
    let (bin, log) = make_fake(dir, "[]", "__none__", fail_stop);
    let runner = ProcessRunner { bin };
    let plan = sample_plan();
    let home = dir.join("home");
    let mdir = dir.join("graphs");
    up_core(&up_req(&plan, &home, &mdir, &good_env), &runner).unwrap();
    std::fs::write(&log, "").unwrap();
    (runner, log, home, mdir)
}

#[cfg(unix)]
#[test]
fn down_stops_reverse_removes_manifest_keeps_trace() {
    let dir = tempfile::tempdir().unwrap();
    let (runner, log, home, mdir) = up_then(dir.path(), "__none__");
    let manifest = sample_manifest(RUN, NOW_MS, Some(home.join("runs").join(RUN).join("trace").display().to_string()));
    let out = down_core(&manifest, &runner, &mdir, &home, false).unwrap();
    assert!(out.contains("stopped builder"), "{out}");
    assert!(out.contains("stopped commander"), "{out}");
    let all = calls(&log);
    assert_eq!(all, vec!["stop -n builder".to_string(), "stop -n commander".to_string()]);
    assert!(!mdir.join(format!("{RUN}.json")).exists(), "manifest removed");
    assert!(home.join("runs").join(RUN).exists(), "run dir kept without --purge");
}

#[cfg(unix)]
#[test]
fn down_purge_deletes_run_dir() {
    let dir = tempfile::tempdir().unwrap();
    let (runner, _log, home, mdir) = up_then(dir.path(), "__none__");
    let manifest = sample_manifest(RUN, NOW_MS, None);
    let out = down_core(&manifest, &runner, &mdir, &home, true).unwrap();
    assert!(out.contains(&format!("purged {RUN}")), "{out}");
    assert!(!home.join("runs").join(RUN).exists(), "run dir deleted");
    assert!(!mdir.join(format!("{RUN}.json")).exists());
}

#[cfg(unix)]
#[test]
fn down_already_gone_is_ok() {
    let dir = tempfile::tempdir().unwrap();
    let (runner, _log, home, mdir) = up_then(dir.path(), "builder");
    let manifest = sample_manifest(RUN, NOW_MS, None);
    let out = down_core(&manifest, &runner, &mdir, &home, false).unwrap();
    assert!(out.contains("already gone: builder"), "{out}");
    assert!(out.contains("stopped commander"), "{out}");
}

#[test]
fn runs_table_counts_live_and_age() {
    let m = sample_manifest(RUN, NOW_MS - 7_200_000, None);
    let live: HashSet<String> = ["commander".to_string()].into_iter().collect();
    let out = runs_output(&[m], &live, NOW_MS);
    assert!(out.contains(RUN), "{out}");
    assert!(out.contains("default"), "{out}");
    assert!(out.contains("1/2"), "{out}");
    assert!(out.contains("2h"), "{out}");
}

#[test]
fn runs_empty() {
    assert_eq!(runs_output(&[], &HashSet::new(), NOW_MS), "no runs\n");
}

#[test]
fn trace_lists_recordings_with_sizes_and_nodes() {
    let dir = tempfile::tempdir().unwrap();
    let trace = dir.path().join("trace");
    std::fs::create_dir_all(&trace).unwrap();
    std::fs::write(trace.join("commander.jsonl"), "12345").unwrap();
    std::fs::write(trace.join("builder.jsonl"), "").unwrap();
    std::fs::write(trace.join("other.jsonl"), "xy").unwrap();
    let m = sample_manifest(RUN, NOW_MS, Some(trace.display().to_string()));
    let out = trace_output(&m).unwrap();
    assert!(out.contains("commander.jsonl  5 bytes  commander"), "{out}");
    assert!(out.contains("builder.jsonl  0 bytes  builder"), "{out}");
    assert!(out.contains("other.jsonl  2 bytes  -"), "{out}");
}

#[test]
fn trace_empty_dir_reports_no_recordings() {
    let dir = tempfile::tempdir().unwrap();
    let m = sample_manifest(RUN, NOW_MS, Some(dir.path().display().to_string()));
    let out = trace_output(&m).unwrap();
    assert!(out.contains("no recordings"), "{out}");
}

#[test]
fn trace_missing_dir_errors() {
    let m = sample_manifest(RUN, NOW_MS, Some("/nonexistent-gl-cli/trace".into()));
    let e = trace_output(&m).unwrap_err();
    assert!(e.contains("does not exist"), "{e}");
    let m2 = sample_manifest(RUN, NOW_MS, None);
    assert!(trace_output(&m2).unwrap_err().contains("no trace directory"));
}

#[test]
fn process_help_lists_commands() {
    let out = std::process::Command::new(env!("CARGO_BIN_EXE_graphloop")).arg("--help").output().unwrap();
    assert!(out.status.success());
    let text = String::from_utf8_lossy(&out.stdout);
    for cmd in ["check", "plan", "graph", "up", "down", "runs", "trace"] { assert!(text.contains(cmd), "{cmd} missing from help: {text}"); }
}

#[test]
fn process_no_args_is_usage_error() {
    let out = std::process::Command::new(env!("CARGO_BIN_EXE_graphloop")).output().unwrap();
    assert_eq!(out.status.code(), Some(2));
}

#[test]
fn process_check_missing_file_exits_1() {
    let out = std::process::Command::new(env!("CARGO_BIN_EXE_graphloop")).args(["check", "/nonexistent-gl-cli/team.yah"]).output().unwrap();
    assert_eq!(out.status.code(), Some(1));
    let err = String::from_utf8_lossy(&out.stderr);
    assert!(err.contains("no such file"), "{err}");
}

#[test]
fn process_plan_missing_file_exits_1() {
    let out = std::process::Command::new(env!("CARGO_BIN_EXE_graphloop")).args(["plan", "/nonexistent-gl-cli/team.yah"]).output().unwrap();
    assert_eq!(out.status.code(), Some(1));
}

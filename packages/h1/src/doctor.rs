//! `h1 doctor`: rename/migration diagnostics. Prints names and paths only, never values
//! from any registry file. Semantics: attention (exit 1) = an old registry (the temp-dir
//! one the pre-rename tool actually used, or the home-dir one) still holds sessions, the
//! old binary is still on PATH, `h1` is missing from PATH, a skill link is broken, an
//! old-binary process is still running, or a lab-gui server runs from outside this
//! repo. Informational only (never attention): the current registry dir not being
//! created yet, an old registry existing with no sessions, the `labctl` compat shim
//! (it execs `h1` by design), absent skill links, lab-gui not currently reachable
//! (it is started on demand), and a lab-gui server running from this repo.
//! With `--fix-hints` it also prints, after the findings, the exact shell command
//! for each fixable finding (kill a stale process, re-link a broken lab-commander
//! skill link, remove the stale binary); hints are printed only, never executed,
//! and findings with no safe one-line fix (either old registry) get no hint.
//! The re-link source is copied verbatim from a lab-commander skill link that
//! already resolves (never derived from the cwd, the executable, or a checkout);
//! when no such link resolves, a fallback line replaces the re-link hint. The
//! stale-binary `rm` hint is preceded by a warning line, because the installed
//! labctl/lab-* scripts still call the old binary until their checkout is updated.

use std::{
    env, fs,
    net::TcpStream,
    path::{Path, PathBuf},
    time::Duration,
};

use anyhow::Result;

/// Directory name of the pre-rename registry under the home dir (functional literal:
/// doctor exists to detect the old location, so it must name it).
const OLD_REGISTRY_DIR_NAME: &str = ".agent-cli-lab";
/// File name of the pre-rename binary (functional literal, same reason).
const OLD_BINARY_NAME: &str = "agent-cli-lab";
/// Directory name of the pre-rename registry inside the temp dir: the old tool
/// resolved its registry the same way h1 does, so its real registry is
/// `<temp dir>/agent-cli-lab`, not the home-dir location (functional literal).
const OLD_TEMP_REGISTRY_DIR_NAME: &str = "agent-cli-lab";
/// Warning printed as a hint immediately above the stale-binary `rm` hint (verbatim).
const RM_OLD_BINARY_WARNING: &str = "only after your lab-commander checkout contains the h1 rename (git pull); the installed labctl and lab-* scripts call the old binary until then";
/// Printed as a hint instead of any `ln -sfn` line when no lab-commander skill
/// link resolves to copy the target from (verbatim).
const NO_WORKING_SKILL_LINK_HINT: &str =
    "no working skill link to copy: run skills/lab-commander/install.sh from your checkout";

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum LinkState {
    Ok,
    Broken,
    Absent,
}

struct Inputs {
    registry_dir: PathBuf,
    registry_exists: bool,
    old_registry_dir: PathBuf,
    old_registry_exists: bool,
    old_sessions: usize,
    h1_on_path: Option<PathBuf>,
    old_binary_on_path: Option<PathBuf>,
    labctl_on_path: Option<PathBuf>,
    skill_links: Vec<(PathBuf, LinkState)>,
    gui_ports: Vec<(u16, bool)>,
    old_temp_registry_dir: PathBuf,
    old_temp_registry_exists: bool,
    old_temp_sessions: usize,
    processes: Vec<String>,
    local_roots: Vec<PathBuf>,
    fix_hints: bool,
    skill_source: Option<PathBuf>,
}

pub struct Report {
    pub lines: Vec<String>,
    pub attention: bool,
}

/// Pure assessment: turn the gathered facts into printable lines and the verdict.
fn assess(inputs: &Inputs) -> Report {
    let mut lines = Vec::new();
    let mut attention = false;
    let mut hints: Vec<String> = Vec::new();
    lines.push(format!(
        "registry dir: {} ({})",
        inputs.registry_dir.display(),
        if inputs.registry_exists {
            "exists"
        } else {
            "not created yet"
        }
    ));
    if inputs.old_temp_sessions > 0 {
        attention = true;
        lines.push(format!(
            "old registry {} still holds {} sessions: those labs do not show in h1 console/GUI",
            inputs.old_temp_registry_dir.display(),
            inputs.old_temp_sessions
        ));
    } else {
        lines.push(format!(
            "old registry dir: {} ({})",
            inputs.old_temp_registry_dir.display(),
            if inputs.old_temp_registry_exists {
                "present, 0 sessions"
            } else {
                "not present"
            }
        ));
    }
    if inputs.old_sessions > 0 {
        attention = true;
        lines.push(format!(
            "warning: old registry {} still holds {} session(s) while {} is in use - old labs will not show in TUI/GUI",
            inputs.old_registry_dir.display(),
            inputs.old_sessions,
            inputs.registry_dir.display()
        ));
    } else {
        lines.push(format!(
            "old registry dir: {} ({})",
            inputs.old_registry_dir.display(),
            if inputs.old_registry_exists {
                "exists, no sessions"
            } else {
                "not present"
            }
        ));
    }
    match &inputs.h1_on_path {
        Some(path) => lines.push(format!("h1 on PATH: {}", path.display())),
        None => {
            attention = true;
            lines.push("h1 on PATH: not found".to_string());
        }
    }
    match &inputs.old_binary_on_path {
        Some(path) => {
            attention = true;
            lines.push(format!(
                "old binary {OLD_BINARY_NAME} on PATH: {} (stale, pre-rename)",
                path.display()
            ));
            hints.push(RM_OLD_BINARY_WARNING.to_string());
            hints.push(format!("rm {}", path.display()));
        }
        None => lines.push(format!("old binary {OLD_BINARY_NAME} on PATH: not found")),
    }
    match &inputs.labctl_on_path {
        Some(path) => lines.push(format!(
            "labctl shim on PATH: {} (compatibility shim, execs h1)",
            path.display()
        )),
        None => lines.push("labctl shim on PATH: not found".to_string()),
    }
    for (link, state) in &inputs.skill_links {
        match state {
            LinkState::Ok => lines.push(format!("skill link {}: ok", link.display())),
            LinkState::Broken => {
                attention = true;
                lines.push(format!("skill link {}: broken", link.display()));
                if link.file_name().is_some_and(|name| name == "lab-commander") {
                    if let Some(source) = &inputs.skill_source {
                        hints.push(format!("ln -sfn {} {}", source.display(), link.display()));
                    } else if !hints.iter().any(|hint| hint == NO_WORKING_SKILL_LINK_HINT) {
                        hints.push(NO_WORKING_SKILL_LINK_HINT.to_string());
                    }
                }
            }
            LinkState::Absent => {
                lines.push(format!("skill link {}: not installed", link.display()))
            }
        }
    }
    for (port, reachable) in &inputs.gui_ports {
        lines.push(format!(
            "lab-gui port {port}: {}",
            if *reachable {
                "reachable"
            } else {
                "not reachable"
            }
        ));
    }
    for finding in process_findings(&inputs.processes, &inputs.local_roots) {
        attention |= finding.attention;
        lines.push(finding.line);
        if let Some(hint) = finding.hint {
            hints.push(hint);
        }
    }
    if inputs.fix_hints && !hints.is_empty() {
        lines.push("fix hints (print only, not executed):".to_string());
        for hint in &hints {
            lines.push(format!("  {hint}"));
        }
    }
    lines.push(
        if attention {
            "doctor: attention needed"
        } else {
            "doctor: ok"
        }
        .to_string(),
    );
    Report { lines, attention }
}

fn find_on_path(dirs: &[PathBuf], name: &str) -> Option<PathBuf> {
    dirs.iter()
        .map(|dir| dir.join(name))
        .find(|candidate| candidate.is_file())
}

fn link_state(path: &Path) -> LinkState {
    if fs::symlink_metadata(path).is_ok_and(|meta| meta.file_type().is_symlink()) {
        // A symlink whose target metadata resolves is ok; dangling is broken.
        if fs::metadata(path).is_ok() {
            LinkState::Ok
        } else {
            LinkState::Broken
        }
    } else if path.exists() {
        LinkState::Ok
    } else {
        LinkState::Absent
    }
}

fn count_registry_sessions(dir: &Path) -> usize {
    fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|item| {
            item.path()
                .extension()
                .is_some_and(|extension| extension == "json")
        })
        .count()
}

struct ProcessFinding {
    line: String,
    attention: bool,
    hint: Option<String>,
}

/// Lexically resolve `.`/`..` components (no filesystem access), so a path
/// spelled with `../..` compares by its resolved form.
fn normalize_path(path: &Path) -> PathBuf {
    use std::path::Component;
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Scan injected `ps`-style lines (`pid command...`) for pre-rename processes.
/// A process is the old binary only when the basename of its first token (after
/// stripping a login-shell leading `-`) is the old binary name, so `login`
/// wrappers, terminal processes and `h1` hosts whose arguments merely mention
/// the old name never match. A lab-gui process is `node` running a
/// `lab-gui/server.mjs` path; its port comes from `--port`, else the default.
fn process_findings(processes: &[String], local_roots: &[PathBuf]) -> Vec<ProcessFinding> {
    let mut findings = Vec::new();
    for raw in processes {
        let Some((pid, command)) = raw.trim_start().split_once(char::is_whitespace) else {
            continue;
        };
        let Ok(pid) = pid.parse::<u32>() else {
            continue;
        };
        let tokens: Vec<&str> = command.split_whitespace().collect();
        let Some(first) = tokens.first() else {
            continue;
        };
        let program = first.trim_start_matches('-');
        let base = Path::new(program)
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("");
        if base == OLD_BINARY_NAME {
            let subcommand = tokens.get(1).copied().unwrap_or("");
            let line = if subcommand == "console" {
                format!("old console pid {pid} cannot see h1 labs: close it and run h1 console")
            } else {
                format!(
                    "old process pid {pid} ({subcommand}) runs the pre-rename binary: restart it as h1"
                )
            };
            findings.push(ProcessFinding {
                line,
                attention: true,
                hint: Some(format!("kill {pid}")),
            });
            continue;
        }
        if base != "node" {
            continue;
        }
        let Some(server) = tokens.iter().copied().find(|token| {
            let path = Path::new(token);
            path.file_name().and_then(|name| name.to_str()) == Some("server.mjs")
                && path
                    .parent()
                    .and_then(|parent| parent.file_name())
                    .and_then(|name| name.to_str())
                    == Some("lab-gui")
        }) else {
            continue;
        };
        let mut port: u16 = 4317;
        let mut iter = tokens.iter();
        while let Some(token) = iter.next() {
            if *token == "--port" {
                if let Some(value) = iter.next().and_then(|value| value.parse::<u16>().ok()) {
                    port = value;
                }
            } else if let Some(value) = token
                .strip_prefix("--port=")
                .and_then(|value| value.parse::<u16>().ok())
            {
                port = value;
            }
        }
        let normalized = normalize_path(Path::new(server));
        let local = local_roots
            .iter()
            .any(|root| normalized.starts_with(normalize_path(root)));
        if local {
            findings.push(ProcessFinding {
                line: format!("lab-gui on port {port} started from {server}: current (this repo)"),
                attention: false,
                hint: None,
            });
        } else {
            findings.push(ProcessFinding {
                line: format!(
                    "lab-gui on port {port} started from {server}: restart it if it shows no labs"
                ),
                attention: true,
                hint: Some(format!("kill {pid}")),
            });
        }
    }
    findings
}

/// The machine's process list, one `pid command` line per process (empty when
/// `ps` is unavailable, e.g. on Windows: no process findings then).
fn process_list() -> Vec<String> {
    std::process::Command::new("ps")
        .args(["-axo", "pid,command"])
        .output()
        .map(|output| {
            String::from_utf8_lossy(&output.stdout)
                .lines()
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// Parse `git worktree list --porcelain` output into the worktree roots
/// that count as "this repo" for a running lab-gui. The FIRST entry is the
/// main worktree — on this machine that is the pre-rename install (the
/// agent-toolkit checkout the old lab-gui servers run from), so it is
/// excluded here; it still counts via the ancestor rule in
/// `local_gui_roots` when doctor itself runs from inside it.
fn worktree_roots(porcelain: &str) -> Vec<PathBuf> {
    porcelain
        .lines()
        .filter_map(|line| line.strip_prefix("worktree "))
        .skip(1)
        .map(PathBuf::from)
        .collect()
}

/// Roots that count as "this repo" for a running lab-gui: every non-main
/// worktree of the repository containing the current directory, plus any
/// ancestor of the current directory or of this executable that is itself
/// a checkout (it contains `packages/lab-gui/server.mjs`).
fn local_gui_roots() -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Ok(output) = std::process::Command::new("git")
        .args(["worktree", "list", "--porcelain"])
        .output()
    {
        roots.extend(worktree_roots(&String::from_utf8_lossy(&output.stdout)));
    }
    let mut bases: Vec<PathBuf> = Vec::new();
    if let Ok(cwd) = env::current_dir() {
        bases.push(cwd);
    }
    if let Ok(exe) = env::current_exe() {
        bases.push(exe);
    }
    for base in &bases {
        for ancestor in base.ancestors() {
            if ancestor
                .join("packages")
                .join("lab-gui")
                .join("server.mjs")
                .is_file()
            {
                roots.push(ancestor.to_path_buf());
            }
        }
    }
    roots.sort();
    roots.dedup();
    roots
}

fn probe_port(port: u16) -> bool {
    let Ok(address) = format!("127.0.0.1:{port}").parse() else {
        return false;
    };
    TcpStream::connect_timeout(&address, Duration::from_millis(250)).is_ok()
}

/// Gather the facts from a concrete environment and assess them. `home`,
/// `temp_dir` and `path_dirs` are parameters (not read from the process env
/// here) so tests can run the whole diagnosis against temp dirs; `probe` is
/// the port probe, `processes` the injected process list and `local_roots`
/// the injected "this repo" roots for lab-gui processes.
#[allow(clippy::too_many_arguments)] // every input is injected so tests can fake the whole environment
fn diagnose_inner(
    registry_dir: &Path,
    home: &Path,
    temp_dir: &Path,
    path_dirs: &[PathBuf],
    gui_ports: &[u16],
    probe: &dyn Fn(u16) -> bool,
    processes: &[String],
    local_roots: &[PathBuf],
    fix_hints: bool,
) -> Report {
    let old_registry_dir = home.join(OLD_REGISTRY_DIR_NAME);
    let old_temp_registry_dir = temp_dir.join(OLD_TEMP_REGISTRY_DIR_NAME);
    let skill_link_candidates = [
        home.join(".claude").join("skills").join("lab-commander"),
        home.join(".codex").join("skills").join("lab-commander"),
        home.join(".local").join("bin").join("labctl"),
        home.join(".local").join("bin").join("lab-gui"),
        home.join(".local").join("bin").join("lab-clean"),
        home.join(".local").join("bin").join("lab-team"),
        home.join(".local").join("bin").join("lab-watch"),
    ];
    let skill_links: Vec<(PathBuf, LinkState)> = skill_link_candidates
        .iter()
        .map(|link| (link.clone(), link_state(link)))
        .collect();
    // The ONLY re-link source: the verbatim target of a lab-commander skill
    // link that already resolves. Never derived from cwd/current_exe/roots.
    let skill_source = skill_links
        .iter()
        .filter(|(link, state)| {
            *state == LinkState::Ok && link.file_name().is_some_and(|name| name == "lab-commander")
        })
        .find_map(|(link, _)| resolved_link_target(link));
    let inputs = Inputs {
        registry_dir: registry_dir.to_path_buf(),
        registry_exists: registry_dir.is_dir(),
        old_registry_exists: old_registry_dir.is_dir(),
        old_sessions: count_registry_sessions(&old_registry_dir),
        old_registry_dir,
        old_temp_registry_exists: old_temp_registry_dir.is_dir(),
        old_temp_sessions: count_registry_sessions(&old_temp_registry_dir),
        old_temp_registry_dir,
        processes: processes.to_vec(),
        local_roots: local_roots.to_vec(),
        fix_hints,
        skill_source,
        h1_on_path: find_on_path(path_dirs, "h1"),
        old_binary_on_path: find_on_path(path_dirs, OLD_BINARY_NAME),
        labctl_on_path: find_on_path(path_dirs, "labctl"),
        skill_links,
        gui_ports: gui_ports.iter().map(|port| (*port, probe(*port))).collect(),
    };
    assess(&inputs)
}

/// Plain diagnosis (no fix hints), as used by the existing tests.
#[cfg(test)]
#[allow(clippy::too_many_arguments)]
fn diagnose(
    registry_dir: &Path,
    home: &Path,
    temp_dir: &Path,
    path_dirs: &[PathBuf],
    gui_ports: &[u16],
    probe: &dyn Fn(u16) -> bool,
    processes: &[String],
    local_roots: &[PathBuf],
) -> Report {
    diagnose_inner(
        registry_dir,
        home,
        temp_dir,
        path_dirs,
        gui_ports,
        probe,
        processes,
        local_roots,
        false,
    )
}

/// The verbatim target of a link that already resolves: its stored symlink
/// target (a relative target resolved against the link's directory), or the
/// canonical path itself when the path is a real directory/file. This is the
/// only source a re-link hint may copy; it is never derived from the cwd,
/// the current executable, or any checkout/worktree root.
fn resolved_link_target(link: &Path) -> Option<PathBuf> {
    if let Ok(target) = fs::read_link(link) {
        if target.is_absolute() {
            Some(target)
        } else {
            link.parent()
                .map(|parent| normalize_path(&parent.join(&target)))
        }
    } else if link.exists() {
        fs::canonicalize(link).ok()
    } else {
        None
    }
}

pub fn run(fix_hints: bool) -> Result<i32> {
    let home = env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
    let path_dirs: Vec<PathBuf> = env::var_os("PATH")
        .map(|path| env::split_paths(&path).collect())
        .unwrap_or_default();
    let gui_port: u16 = env::var("LAB_GUI_PORT")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(4317);
    let local_roots = local_gui_roots();
    let report = diagnose_inner(
        &crate::session::session_dir(),
        &home,
        &env::temp_dir(),
        &path_dirs,
        &[gui_port],
        &probe_port,
        &process_list(),
        &local_roots,
        fix_hints,
    );
    for line in &report.lines {
        println!("{line}");
    }
    Ok(if report.attention { 1 } else { 0 })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(tag: &str) -> PathBuf {
        let root = env::temp_dir().join(format!("h1-doctor-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).expect("create temp root");
        root
    }

    #[test]
    fn clean_temp_setup_needs_no_attention() {
        let root = temp_root("clean");
        let registry = root.join("sessions");
        fs::create_dir_all(&registry).expect("registry");
        let home = root.join("home");
        fs::create_dir_all(&home).expect("home");
        let bin = root.join("bin");
        fs::create_dir_all(&bin).expect("bin");
        fs::write(bin.join("h1"), "fake").expect("fake h1");
        let report = diagnose(
            &registry,
            &home,
            &root.join("tmp"),
            &[bin],
            &[4317],
            &|_| false,
            &[],
            &[],
        );
        assert!(!report.attention, "lines: {:?}", report.lines);
        assert!(
            report
                .lines
                .iter()
                .any(|line| line.starts_with("registry dir:")),
            "lines: {:?}",
            report.lines
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn planted_old_registry_session_warns_on_one_line_and_needs_attention() {
        let root = temp_root("oldreg");
        let registry = root.join("sessions");
        fs::create_dir_all(&registry).expect("registry");
        let home = root.join("home");
        let old_dir = home.join(OLD_REGISTRY_DIR_NAME);
        fs::create_dir_all(&old_dir).expect("old registry");
        fs::write(old_dir.join("oldlab.json"), "{}").expect("plant fake session");
        let bin = root.join("bin");
        fs::create_dir_all(&bin).expect("bin");
        fs::write(bin.join("h1"), "fake").expect("fake h1");
        let report = diagnose(
            &registry,
            &home,
            &root.join("tmp"),
            &[bin],
            &[4317],
            &|_| false,
            &[],
            &[],
        );
        assert!(report.attention, "lines: {:?}", report.lines);
        let warnings: Vec<&String> = report
            .lines
            .iter()
            .filter(|line| line.contains("still holds"))
            .collect();
        assert_eq!(warnings.len(), 1, "lines: {:?}", report.lines);
        assert!(
            warnings[0].contains("will not show in TUI/GUI"),
            "warning: {}",
            warnings[0]
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn doctor_help_states_what_it_checks() {
        use clap::CommandFactory;
        let command = crate::Cli::command();
        let doctor = command
            .find_subcommand("doctor")
            .expect("doctor subcommand is wired into the CLI");
        let help = doctor.clone().render_long_help().to_string();
        for needle in ["registry", "PATH", "skill links", "lab-gui", "--fix-hints"] {
            assert!(help.contains(needle), "help missing {needle:?}: {help}");
        }
    }

    #[test]
    fn every_doctor_line_kind_has_a_documented_sample_in_the_readme() {
        // Every line kind `assess` / `process_findings` can emit (each status
        // variant, each process finding, the fix-hints header, each hint kind
        // incl. the rm warning and the no-resolving-link fallback, and both
        // verdicts) must have one verbatim sample in the README Doctor section.
        let readme = include_str!("../README.md");
        let samples = [
            "registry dir: /tmp/h1 (exists)",
            "registry dir: /tmp/h1 (not created yet)",
            "old registry /tmp/agent-cli-lab still holds 2 sessions: those labs do not show in h1 console/GUI",
            "old registry dir: /tmp/agent-cli-lab (present, 0 sessions)",
            "old registry dir: /tmp/agent-cli-lab (not present)",
            "warning: old registry /Users/x/.agent-cli-lab still holds 1 session(s) while /tmp/h1 is in use - old labs will not show in TUI/GUI",
            "old registry dir: /Users/x/.agent-cli-lab (exists, no sessions)",
            "old registry dir: /Users/x/.agent-cli-lab (not present)",
            "h1 on PATH: /Users/x/.local/bin/h1",
            "h1 on PATH: not found",
            "old binary agent-cli-lab on PATH: /Users/x/.local/bin/agent-cli-lab (stale, pre-rename)",
            "old binary agent-cli-lab on PATH: not found",
            "labctl shim on PATH: /Users/x/.local/bin/labctl (compatibility shim, execs h1)",
            "labctl shim on PATH: not found",
            "skill link /Users/x/.codex/skills/lab-commander: ok",
            "skill link /Users/x/.codex/skills/lab-commander: broken",
            "skill link /Users/x/.codex/skills/lab-commander: not installed",
            "lab-gui port 4317: reachable",
            "lab-gui port 4317: not reachable",
            "old console pid 1234 cannot see h1 labs: close it and run h1 console",
            "old process pid 1235 (host) runs the pre-rename binary: restart it as h1",
            "lab-gui on port 4317 started from /Users/x/checkout/packages/lab-gui/server.mjs: current (this repo)",
            "lab-gui on port 4317 started from /other/checkout/packages/lab-gui/server.mjs: restart it if it shows no labs",
            "doctor: ok",
            "doctor: attention needed",
            "fix hints (print only, not executed):",
            "  kill 1234",
            "  ln -sfn /Users/x/checkout/skills/lab-commander /Users/x/.codex/skills/lab-commander",
            "  no working skill link to copy: run skills/lab-commander/install.sh from your checkout",
            "  only after your lab-commander checkout contains the h1 rename (git pull); the installed labctl and lab-* scripts call the old binary until then",
            "  rm /Users/x/.local/bin/agent-cli-lab",
        ];
        for sample in samples {
            assert!(
                readme.contains(sample),
                "README Doctor section lacks a verbatim sample for line kind: {sample:?}"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn resolved_link_target_returns_the_stored_symlink_target() {
        let root = temp_root("linksrc");
        let target = root.join("skill-target");
        fs::create_dir_all(&target).expect("target dir");
        let link = root.join("lab-commander");
        std::os::unix::fs::symlink(&target, &link).expect("plant resolving link");
        assert_eq!(resolved_link_target(&link), Some(target));
        assert_eq!(resolved_link_target(&root.join("missing")), None);
        let _ = fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn fix_hints_print_kill_ln_rm_and_skip_registries() {
        let root = temp_root("hints");
        let registry = root.join("sessions");
        fs::create_dir_all(&registry).expect("registry");
        let home = root.join("home");
        let skill_source = root.join("skill-target");
        fs::create_dir_all(&skill_source).expect("skill target");
        let claude_dir = home.join(".claude").join("skills");
        fs::create_dir_all(&claude_dir).expect("claude link dir");
        std::os::unix::fs::symlink(&skill_source, claude_dir.join("lab-commander"))
            .expect("plant resolving link");
        let decoy = root.join("repo").join("skills").join("lab-commander");
        fs::create_dir_all(&decoy).expect("decoy checkout skill dir");
        let link_dir = home.join(".codex").join("skills");
        fs::create_dir_all(&link_dir).expect("link dir");
        let link = link_dir.join("lab-commander");
        std::os::unix::fs::symlink(root.join("dead-target"), &link).expect("plant broken link");
        let tmp = root.join("tmp");
        let old_temp = tmp.join(OLD_TEMP_REGISTRY_DIR_NAME);
        fs::create_dir_all(&old_temp).expect("old temp registry");
        fs::write(old_temp.join("a.json"), "{}").expect("old session");
        let bin = root.join("bin");
        fs::create_dir_all(&bin).expect("bin");
        fs::write(bin.join("h1"), "fake").expect("fake h1");
        fs::write(bin.join(OLD_BINARY_NAME), "fake").expect("stale binary");
        let processes: Vec<String> = vec![
            "81921 /Users/x/.local/bin/agent-cli-lab console".to_string(),
            "21800 node /Users/x/Downloads/agent-toolkit/packages/lab-gui/server.mjs --open"
                .to_string(),
        ];
        let report = diagnose_inner(
            &registry,
            &home,
            &tmp,
            std::slice::from_ref(&bin),
            &[4317],
            &|_| false,
            &processes,
            &[],
            true,
        );
        assert!(report.attention, "lines: {:?}", report.lines);
        for expected in [
            "fix hints (print only, not executed):".to_string(),
            "  kill 81921".to_string(),
            "  kill 21800".to_string(),
            format!("  ln -sfn {} {}", skill_source.display(), link.display()),
            format!("  {RM_OLD_BINARY_WARNING}"),
            format!("  rm {}", bin.join(OLD_BINARY_NAME).display()),
        ] {
            assert!(
                report.lines.iter().any(|line| line == &expected),
                "missing {expected:?} in {:?}",
                report.lines
            );
        }
        let hint_lines: Vec<&String> = report
            .lines
            .iter()
            .filter(|line| line.starts_with("  "))
            .collect();
        assert_eq!(hint_lines.len(), 5, "hints: {hint_lines:?}");
        assert!(
            hint_lines
                .iter()
                .all(|line| !line.contains(&decoy.display().to_string())),
            "exe/cwd-style decoy path in {hint_lines:?}"
        );
        let rm_index = report
            .lines
            .iter()
            .position(|line| *line == format!("  rm {}", bin.join(OLD_BINARY_NAME).display()))
            .expect("rm hint");
        assert_eq!(
            report.lines[rm_index - 1],
            format!("  {RM_OLD_BINARY_WARNING}"),
            "warning must immediately precede rm: {:?}",
            report.lines
        );
        assert!(
            hint_lines
                .iter()
                .all(|line| !line.contains(&old_temp.display().to_string())),
            "registry hint in {hint_lines:?}"
        );
        let plain = diagnose(
            &registry,
            &home,
            &tmp,
            &[bin],
            &[4317],
            &|_| false,
            &processes,
            &[],
        );
        assert_eq!(plain.attention, report.attention);
        assert!(
            plain
                .lines
                .iter()
                .all(|line| !line.contains("fix hints") && !line.starts_with("  kill")),
            "plain: {:?}",
            plain.lines
        );
        assert_eq!(report.lines.len(), plain.lines.len() + 6);
        let _ = fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn fix_hints_without_a_resolving_skill_link_print_the_fallback() {
        let root = temp_root("hintsnone");
        let registry = root.join("sessions");
        fs::create_dir_all(&registry).expect("registry");
        let home = root.join("home");
        for host in [".claude", ".codex"] {
            let dir = home.join(host).join("skills");
            fs::create_dir_all(&dir).expect("link dir");
            std::os::unix::fs::symlink(root.join("dead-target"), dir.join("lab-commander"))
                .expect("plant broken link");
        }
        let bin = root.join("bin");
        fs::create_dir_all(&bin).expect("bin");
        fs::write(bin.join("h1"), "fake").expect("fake h1");
        let report = diagnose_inner(
            &registry,
            &home,
            &root.join("tmp"),
            &[bin],
            &[4317],
            &|_| false,
            &[],
            &[],
            true,
        );
        assert!(report.attention, "lines: {:?}", report.lines);
        assert!(
            report
                .lines
                .iter()
                .any(|line| line == &format!("  {NO_WORKING_SKILL_LINK_HINT}")),
            "fallback missing in {:?}",
            report.lines
        );
        assert!(
            report.lines.iter().all(|line| !line.contains("ln -sfn")),
            "ln hint in {:?}",
            report.lines
        );
        assert_eq!(
            report
                .lines
                .iter()
                .filter(|line| line.contains(NO_WORKING_SKILL_LINK_HINT))
                .count(),
            1,
            "fallback exactly once in {:?}",
            report.lines
        );
        let _ = fs::remove_dir_all(&root);
    }

    fn report_in(root: &Path, processes: &[String], local_roots: &[PathBuf]) -> Report {
        let registry = root.join("sessions");
        fs::create_dir_all(&registry).expect("registry");
        let home = root.join("home");
        fs::create_dir_all(&home).expect("home");
        let bin = root.join("bin");
        fs::create_dir_all(&bin).expect("bin");
        fs::write(bin.join("h1"), "fake").expect("fake h1");
        diagnose(
            &registry,
            &home,
            &root.join("tmp"),
            &[bin],
            &[4317],
            &|_| false,
            processes,
            local_roots,
        )
    }

    #[test]
    fn temp_old_registry_with_sessions_needs_attention() {
        let root = temp_root("tmpold");
        let registry = root.join("sessions");
        fs::create_dir_all(&registry).expect("registry");
        let home = root.join("home");
        fs::create_dir_all(&home).expect("home");
        let bin = root.join("bin");
        fs::create_dir_all(&bin).expect("bin");
        fs::write(bin.join("h1"), "fake").expect("fake h1");
        let tmp = root.join("tmp");
        let old_temp = tmp.join(OLD_TEMP_REGISTRY_DIR_NAME);
        fs::create_dir_all(&old_temp).expect("old temp registry");
        fs::write(old_temp.join("a.json"), "{}").expect("session a");
        fs::write(old_temp.join("b.json"), "{}").expect("session b");
        fs::write(old_temp.join("notes.txt"), "x").expect("not a session");
        let report = diagnose(
            &registry,
            &home,
            &tmp,
            &[bin],
            &[4317],
            &|_| false,
            &[],
            &[],
        );
        assert!(report.attention, "lines: {:?}", report.lines);
        let expected = format!(
            "old registry {} still holds 2 sessions: those labs do not show in h1 console/GUI",
            old_temp.display()
        );
        assert!(
            report.lines.iter().any(|line| line == &expected),
            "lines: {:?}",
            report.lines
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn empty_temp_old_registry_is_informational() {
        let root = temp_root("tmpempty");
        let tmp = root.join("tmp");
        let old_temp = tmp.join(OLD_TEMP_REGISTRY_DIR_NAME);
        fs::create_dir_all(&old_temp).expect("old temp registry");
        let report = report_in(&root, &[], &[]);
        assert!(!report.attention, "lines: {:?}", report.lines);
        let expected = format!(
            "old registry dir: {} (present, 0 sessions)",
            old_temp.display()
        );
        assert!(
            report.lines.iter().any(|line| line == &expected),
            "lines: {:?}",
            report.lines
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn old_processes_and_outside_lab_gui_need_attention() {
        let root = temp_root("procs");
        let processes: Vec<String> = [
            "81921 -/Users/x/.local/bin/agent-cli-lab console --here --view labs",
            "4242 /Users/x/.local/bin/agent-cli-lab host --name ux",
            "21800 node /Users/x/Downloads/agent-toolkit/skills/lab-commander/bin/../../../packages/lab-gui/server.mjs --open",
            "71756 node /Users/x/Downloads/agent-toolkit/packages/lab-gui/server.mjs --port 4320",
        ]
        .iter()
        .map(|line| line.to_string())
        .collect();
        let report = report_in(&root, &processes, &[root.join("repo")]);
        assert!(report.attention, "lines: {:?}", report.lines);
        for expected in [
            "old console pid 81921 cannot see h1 labs: close it and run h1 console",
            "old process pid 4242 (host) runs the pre-rename binary: restart it as h1",
            "lab-gui on port 4317 started from /Users/x/Downloads/agent-toolkit/skills/lab-commander/bin/../../../packages/lab-gui/server.mjs: restart it if it shows no labs",
            "lab-gui on port 4320 started from /Users/x/Downloads/agent-toolkit/packages/lab-gui/server.mjs: restart it if it shows no labs",
        ] {
            assert!(
                report.lines.iter().any(|line| line == expected),
                "missing {expected:?} in {:?}",
                report.lines
            );
        }
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn worktree_roots_exclude_the_main_worktree() {
        let porcelain = "worktree /Users/x/Downloads/agent-toolkit\nHEAD 78234fb\nbranch refs/heads/feat/old\n\nworktree /Users/x/Downloads/graphloop-lab/repo\nHEAD 776d7f7\n\nworktree /Users/x/Downloads/graphloop-lab/wt/w-sweep\nHEAD 1218227\n";
        assert_eq!(
            worktree_roots(porcelain),
            vec![
                PathBuf::from("/Users/x/Downloads/graphloop-lab/repo"),
                PathBuf::from("/Users/x/Downloads/graphloop-lab/wt/w-sweep"),
            ]
        );
        assert!(worktree_roots("").is_empty());
    }

    #[test]
    fn h1_and_repo_local_lab_gui_processes_are_clean() {
        let root = temp_root("cleanprocs");
        let checkout = root.join("checkout");
        let processes: Vec<String> = vec![
            "35161 -/Users/x/.local/bin/h1 console --here --view labs".to_string(),
            "11396 /Users/x/.local/bin/h1 host --name fl --title agent-cli-lab -> h1 -- pi".to_string(),
            "81919 /usr/bin/login -flp x /bin/bash -c exec -l '/Users/x/.local/bin/agent-cli-lab' 'console'".to_string(),
            format!(
                "35098 node {}/packages/lab-gui/server.mjs --port 4321 --open",
                checkout.display()
            ),
        ];
        let report = report_in(&root, &processes, &[checkout]);
        assert!(!report.attention, "lines: {:?}", report.lines);
        for forbidden in ["old console", "old process", "restart it"] {
            assert!(
                report.lines.iter().all(|line| !line.contains(forbidden)),
                "{forbidden:?} in {:?}",
                report.lines
            );
        }
        assert!(
            report
                .lines
                .iter()
                .any(|line| line.contains("current (this repo)")),
            "lines: {:?}",
            report.lines
        );
        let _ = fs::remove_dir_all(&root);
    }
}

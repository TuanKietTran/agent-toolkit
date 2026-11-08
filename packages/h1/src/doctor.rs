//! `h1 doctor`: rename/migration diagnostics. Prints names and paths only, never values
//! from any registry file. Semantics: attention (exit 1) = the old registry still holds
//! sessions, the old binary is still on PATH, `h1` is missing from PATH, or a skill link
//! is broken. Informational only (never attention): the current registry dir not being
//! created yet, the old registry existing with no sessions, the `labctl` compat shim
//! (it execs `h1` by design), absent skill links, and lab-gui not currently reachable
//! (it is started on demand).

use std::{
    env,
    fs,
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
}

pub struct Report {
    pub lines: Vec<String>,
    pub attention: bool,
}

/// Pure assessment: turn the gathered facts into printable lines and the verdict.
fn assess(inputs: &Inputs) -> Report {
    let mut lines = Vec::new();
    let mut attention = false;
    lines.push(format!(
        "registry dir: {} ({})",
        inputs.registry_dir.display(),
        if inputs.registry_exists {
            "exists"
        } else {
            "not created yet"
        }
    ));
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
            }
            LinkState::Absent => {
                lines.push(format!("skill link {}: not installed", link.display()))
            }
        }
    }
    for (port, reachable) in &inputs.gui_ports {
        lines.push(format!(
            "lab-gui port {port}: {}",
            if *reachable { "reachable" } else { "not reachable" }
        ));
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

fn probe_port(port: u16) -> bool {
    let Ok(address) = format!("127.0.0.1:{port}").parse() else {
        return false;
    };
    TcpStream::connect_timeout(&address, Duration::from_millis(250)).is_ok()
}

/// Gather the facts from a concrete environment and assess them. `home` and
/// `path_dirs` are parameters (not read from the process env here) so tests can
/// run the whole diagnosis against temp dirs; `probe` is the port probe.
fn diagnose(
    registry_dir: &Path,
    home: &Path,
    path_dirs: &[PathBuf],
    gui_ports: &[u16],
    probe: &dyn Fn(u16) -> bool,
) -> Report {
    let old_registry_dir = home.join(OLD_REGISTRY_DIR_NAME);
    let skill_link_candidates = [
        home.join(".claude").join("skills").join("lab-commander"),
        home.join(".codex").join("skills").join("lab-commander"),
        home.join(".local").join("bin").join("labctl"),
        home.join(".local").join("bin").join("lab-gui"),
        home.join(".local").join("bin").join("lab-clean"),
        home.join(".local").join("bin").join("lab-team"),
        home.join(".local").join("bin").join("lab-watch"),
    ];
    let inputs = Inputs {
        registry_dir: registry_dir.to_path_buf(),
        registry_exists: registry_dir.is_dir(),
        old_registry_exists: old_registry_dir.is_dir(),
        old_sessions: count_registry_sessions(&old_registry_dir),
        old_registry_dir,
        h1_on_path: find_on_path(path_dirs, "h1"),
        old_binary_on_path: find_on_path(path_dirs, OLD_BINARY_NAME),
        labctl_on_path: find_on_path(path_dirs, "labctl"),
        skill_links: skill_link_candidates
            .iter()
            .map(|link| (link.clone(), link_state(link)))
            .collect(),
        gui_ports: gui_ports
            .iter()
            .map(|port| (*port, probe(*port)))
            .collect(),
    };
    assess(&inputs)
}

pub fn run() -> Result<i32> {
    let home = env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_default();
    let path_dirs: Vec<PathBuf> = env::var_os("PATH")
        .map(|path| env::split_paths(&path).collect())
        .unwrap_or_default();
    let gui_port: u16 = env::var("LAB_GUI_PORT")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(4317);
    let report = diagnose(
        &crate::session::session_dir(),
        &home,
        &path_dirs,
        &[gui_port],
        &probe_port,
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
        let report = diagnose(&registry, &home, &[bin], &[4317], &|_| false);
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
        let report = diagnose(&registry, &home, &[bin], &[4317], &|_| false);
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
        for needle in ["registry", "PATH", "skill links", "lab-gui"] {
            assert!(help.contains(needle), "help missing {needle:?}: {help}");
        }
    }
}

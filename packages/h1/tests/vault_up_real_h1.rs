//! H10: end-to-end `h1 up` against the REAL `h1` binary.
//!
//! Gate: if `H1_BIN` is unset or does not point at an executable file, this
//! test passes immediately (skipped). When `H1_BIN` is set to an executable,
//! the test MUST run for real: it prints an `H10_REAL_H1_RAN` marker only
//! after a real lab was opened, inspected, and closed, so a silent skip is
//! distinguishable from a run in `--nocapture` output.
//!
//! Flow: a one-harness `cat` spec whose `open.env` takes `FLEET_TOKEN` from a
//! `command`-provider vault (a tiny script echoing a fixed fake sentinel).
//! `h1 up` hands the secret to `h1 open` in its process environment
//! only (never argv). Delivery is verified through the real h1: the session
//! registry file `$H1_DIR/<name>.json` names the h1 host pid, and on macOS
//! `ps eww -p <host pid>` shows that host's environment, which must contain
//! `FLEET_TOKEN=<sentinel>` (verified by hand against the real h1 before
//! this test was written; `ps eww` on the hosted `cat` child shows no env
//! on macOS, so the child pid is never used). The sentinel VALUE must appear
//! in NONE of: `up`/`runs`/`trace`/`down` output, the manifest, any file
//! under the run dir, the session registry file, or `h1 list --json`.
//!
//! Cleanup runs even on assertion failure: a Drop guard runs
//! `h1 down --run <run>` (once the run is known) and `h1 stop` for
//! the lab, then removes the isolated temp root. No lab or temp dir is
//! left behind.

use std::path::{Path, PathBuf};
use std::process::{Command, Output};

const SENTINEL: &str = "FAKE_VAULT_UP_SENTINEL_13579";
const SESSION: &str = "alpha";

const SPEC: &str = r##"yah 1

provider "anthropic" {
  type = "anthropic"
}

model "haiku" {
  provider = "anthropic"
  id       = "claude-haiku-5-5"
}

system_one {
  fallback = "haiku"
}

vault "cmdv" {
  provider = "command"
  command  = ["__CMD__", "{ref}"]
  secrets  = {
    TOKEN = "TOKEN"
  }
}

harness "alpha" {
  kind  = "h1"
  role  = "worker"
  model = "haiku"
  open {
    command  = ["cat"]
    detached = true
    env = {
      FLEET_TOKEN = "${vault.cmdv.TOKEN}"
    }
  }
}

team "t" {
  root    = "alpha"
  members = []
}
"##;

struct Iso {
    root: PathBuf,
    home: PathBuf,
    h1_dir: PathBuf,
    h1_bin: PathBuf,
    run: Option<String>,
}

impl Iso {
    fn driver(&self, args: &[&str]) -> Output {
        Command::new(env!("CARGO_BIN_EXE_h1"))
            .args(args)
            .env("GRAPHLOOP_HOME", &self.home)
            .env("H1_DIR", &self.h1_dir)
            .env("H1_BIN", &self.h1_bin)
            .output()
            .unwrap()
    }
    fn h1(&self, args: &[&str]) -> Output {
        Command::new(&self.h1_bin)
            .args(args)
            .env("H1_DIR", &self.h1_dir)
            .output()
            .unwrap()
    }
}

impl Drop for Iso {
    fn drop(&mut self) {
        if let Some(run) = &self.run {
            let _ = self.driver(&["down", "--run", run]);
        }
        let _ = self.h1(&["stop", "-n", SESSION]);
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn combined(out: &Output) -> String {
    format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    )
}

fn assert_clean(what: &str, out: &Output) -> String {
    let text = combined(out);
    assert!(out.status.success(), "{what} failed: {text}");
    assert!(
        !text.contains(SENTINEL),
        "{what} LEAKED the vault sentinel: {text}"
    );
    text
}

fn all_files_text(dir: &Path) -> String {
    let mut out = String::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&d) else {
            continue;
        };
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() {
                stack.push(p);
            } else if let Ok(bytes) = std::fs::read(&p) {
                out.push_str(&String::from_utf8_lossy(&bytes));
                out.push('\n');
            }
        }
    }
    out
}

fn registry_pid(session_json: &str) -> u32 {
    let at = session_json
        .find("\"pid\"")
        .expect("session registry has no pid field");
    let digits: String = session_json[at + 6..]
        .chars()
        .skip_while(|c| !c.is_ascii_digit())
        .take_while(|c| c.is_ascii_digit())
        .collect();
    digits
        .parse()
        .expect("session registry pid is not a number")
}

#[cfg(unix)]
fn h1_bin_gate() -> Option<PathBuf> {
    use std::os::unix::fs::PermissionsExt;
    let raw = std::env::var_os("H1_BIN").filter(|v| !v.is_empty())?;
    let path = PathBuf::from(raw);
    let meta = std::fs::metadata(&path).ok()?;
    if meta.is_file() && meta.permissions().mode() & 0o111 != 0 {
        Some(path)
    } else {
        None
    }
}

#[cfg(unix)]
#[test]
fn h1_up_against_real_h1_delivers_vault_secret_without_leaking_it() {
    let Some(h1_bin) = h1_bin_gate() else {
        eprintln!("H10_SKIPPED: H1_BIN unset or not executable");
        return;
    };
    // Short root under /tmp: the h1 session socket lives under H1_DIR and
    // unix socket paths have a tight length limit.
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = PathBuf::from(format!("/tmp/glh10-{}-{stamp}", std::process::id()));
    std::fs::create_dir_all(&root).unwrap();
    let mut iso = Iso {
        home: root.join("glhome"),
        h1_dir: root.join("h1dir"),
        h1_bin,
        run: None,
        root: root.clone(),
    };

    // The command-provider program: ignores argv, prints the sentinel.
    {
        use std::os::unix::fs::PermissionsExt;
        let cmd = root.join("cmdcli");
        std::fs::write(&cmd, format!("#!/bin/sh\nprintf '%s\\n' '{SENTINEL}'\n")).unwrap();
        std::fs::set_permissions(&cmd, std::fs::Permissions::from_mode(0o755)).unwrap();
        let spec = SPEC.replace("__CMD__", &cmd.display().to_string());
        std::fs::write(root.join("fleet.yah"), spec).unwrap();
    }
    let yah = root.join("fleet.yah").display().to_string();

    // up: real h1 (built bin as driver, H1_BIN as the child it opens labs through), real cat lab.
    let out = iso.driver(&["up", &yah]);
    let up_text = assert_clean("h1 up", &out);
    let run = up_text
        .lines()
        .next()
        .and_then(|l| l.strip_prefix("up: "))
        .and_then(|r| r.split_whitespace().next())
        .expect("up output has no run name")
        .to_owned();
    iso.run = Some(run.clone());

    // The manifest (in H1_DIR/graphs) and every file under the run dir.
    let manifest_path = iso.h1_dir.join("graphs").join(format!("{run}.json"));
    let manifest = std::fs::read_to_string(&manifest_path)
        .unwrap_or_else(|e| panic!("manifest missing at {}: {e}", manifest_path.display()));
    assert!(
        !manifest.contains(SENTINEL),
        "manifest LEAKED the vault sentinel: {manifest}"
    );
    let run_dir = iso.home.join("runs").join(&run);
    let run_files = all_files_text(&run_dir);
    assert!(
        !run_files.contains(SENTINEL),
        "a file under {} LEAKED the vault sentinel",
        run_dir.display()
    );

    // Delivery: the h1 host process environment, read back through the
    // registry pid the real h1 wrote. Retry briefly for ps visibility.
    let session_path = iso.h1_dir.join(format!("{SESSION}.json"));
    let session_json = std::fs::read_to_string(&session_path).unwrap_or_else(|e| {
        panic!(
            "session registry missing at {}: {e}",
            session_path.display()
        )
    });
    assert!(
        !session_json.contains(SENTINEL),
        "session registry LEAKED the vault sentinel: {session_json}"
    );
    let pid = registry_pid(&session_json);
    let want = format!("FLEET_TOKEN={SENTINEL}");
    let mut ps_text = String::new();
    for _ in 0..25 {
        let ps = Command::new("ps")
            .args(["eww", "-p", &pid.to_string()])
            .output()
            .unwrap();
        ps_text = String::from_utf8_lossy(&ps.stdout).into_owned();
        if ps_text.contains(&want) {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(200));
    }
    assert!(
        ps_text.contains(&want),
        "sentinel did not reach the lab: ps eww -p {pid} shows no {want}"
    );

    // h1 list --json: names the lab, never the value.
    let out = iso.h1(&["list", "--json"]);
    let list_text = assert_clean("h1 list --json", &out);
    assert!(
        list_text.contains(SESSION),
        "h1 list does not name the lab: {list_text}"
    );

    // runs / trace: read-only surfaces over the live run.
    let out = iso.driver(&["runs"]);
    let runs_text = assert_clean("h1 runs", &out);
    assert!(
        runs_text.contains(&run),
        "runs does not list the run: {runs_text}"
    );
    let out = iso.driver(&["trace", &run]);
    assert_clean("h1 trace", &out);

    // down: stops the lab, removes the manifest and the registry entry.
    let out = iso.driver(&["down", "--run", &run]);
    let down_text = assert_clean("h1 down", &out);
    assert!(
        down_text.contains(SESSION),
        "down did not report the lab: {down_text}"
    );
    assert!(!manifest_path.exists(), "down left the manifest behind");
    assert!(
        !session_path.exists(),
        "down left the session registry behind"
    );
    iso.run = None;

    eprintln!("H10_REAL_H1_RAN run={run} session={SESSION} host_pid={pid}");
}

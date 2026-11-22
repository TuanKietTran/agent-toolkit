//! Resource ownership registry: every allocation is recorded against a run in h1's own
//! session dir (`resources.json`), so `release`/`gc` can free them and doctor can flag
//! leaks belonging to runs that are no longer live.

use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Worktree,
    Clone,
    Tmp,
    Port,
    Proc,
}

impl Kind {
    pub fn parse(s: &str) -> Result<Kind, String> {
        match s {
            "worktree" => Ok(Kind::Worktree),
            "clone" => Ok(Kind::Clone),
            "tmp" => Ok(Kind::Tmp),
            "port" => Ok(Kind::Port),
            "proc" => Ok(Kind::Proc),
            other => Err(format!("unknown resource kind: {other}")),
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Kind::Worktree => "worktree",
            Kind::Clone => "clone",
            Kind::Tmp => "tmp",
            Kind::Port => "port",
            Kind::Proc => "proc",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Resource {
    pub kind: Kind,
    pub value: String,
    pub run: String,
    pub created_unix: u64,
}

pub fn store_path(dir: &Path) -> PathBuf {
    dir.join("resources.json")
}

pub fn load(dir: &Path) -> Vec<Resource> {
    let Ok(text) = fs::read_to_string(store_path(dir)) else {
        return Vec::new();
    };
    serde_json::from_str(&text).unwrap_or_default()
}

pub fn save(dir: &Path, items: &[Resource]) -> std::io::Result<()> {
    fs::create_dir_all(dir)?;
    let text = serde_json::to_string_pretty(items)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    fs::write(store_path(dir), text)
}

pub fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

pub fn alloc(dir: &Path, kind: Kind, value: &str, run: &str) -> std::io::Result<Resource> {
    let mut items = load(dir);
    if let Some(existing) = items
        .iter()
        .find(|r| r.kind == kind && r.value == value && r.run == run)
    {
        return Ok(existing.clone());
    }
    let resource = Resource {
        kind,
        value: value.to_string(),
        run: run.to_string(),
        created_unix: now_unix(),
    };
    items.push(resource.clone());
    save(dir, &items)?;
    Ok(resource)
}

/// Whether a resource kind's value is a filesystem path.
pub fn is_path_kind(kind: Kind) -> bool {
    matches!(kind, Kind::Worktree | Kind::Clone | Kind::Tmp)
}

/// Makes a path value absolute against `cwd`, so a later `release`/`gc` run from another
/// directory frees the same path that was allocated, never a different relative one.
pub fn absolute_value(kind: Kind, value: &str, cwd: &Path) -> String {
    if !is_path_kind(kind) {
        return value.to_string();
    }
    let path = Path::new(value);
    if path.is_absolute() {
        value.to_string()
    } else {
        cwd.join(path).display().to_string()
    }
}

fn git(dir: &Path, args: &[&str]) -> Option<String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// `Some(true)` when `dir` is inside a git work tree with uncommitted or untracked changes,
/// `Some(false)` when it is a clean work tree, `None` when it is not a git work tree.
fn git_dirty(dir: &Path) -> Option<bool> {
    git(dir, &["rev-parse", "--is-inside-work-tree"]).filter(|out| out == "true")?;
    git(dir, &["status", "--porcelain"]).map(|out| !out.is_empty())
}

/// Frees one resource. `Err(reason)` means it was deliberately kept: work that is not
/// committed is never deleted, and a git worktree is only removed through git (never
/// `--force`), which keeps its branch and refuses a dirty or locked worktree.
pub fn free_one(r: &Resource) -> Result<(), String> {
    match r.kind {
        Kind::Worktree => {
            let path = Path::new(&r.value);
            if !path.exists() {
                return Ok(());
            }
            match git_dirty(path) {
                None => fs::remove_dir_all(path).map_err(|e| e.to_string()),
                Some(true) => Err("uncommitted changes".to_string()),
                Some(false) => {
                    let common = git(
                        path,
                        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
                    )
                    .ok_or("cannot find its repository")?;
                    let output = Command::new("git")
                        .arg("-C")
                        .arg(&common)
                        .args(["worktree", "remove"])
                        .arg(path)
                        .output()
                        .map_err(|e| e.to_string())?;
                    if output.status.success() {
                        let _ = Command::new("git")
                            .arg("-C")
                            .arg(&common)
                            .args(["worktree", "prune"])
                            .output();
                        Ok(())
                    } else {
                        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
                    }
                }
            }
        }
        Kind::Clone | Kind::Tmp => {
            let path = Path::new(&r.value);
            if r.kind == Kind::Clone && git_dirty(path) == Some(true) {
                return Err("uncommitted changes".to_string());
            }
            if path.is_dir() {
                fs::remove_dir_all(path).map_err(|e| e.to_string())
            } else if path.is_file() {
                fs::remove_file(path).map_err(|e| e.to_string())
            } else {
                Ok(())
            }
        }
        Kind::Port => Ok(()),
        Kind::Proc => {
            if r.value.parse::<u32>().is_ok() {
                #[cfg(unix)]
                let _ = Command::new("kill").arg(&r.value).output();
                // The process and the children it started, like `kill` on a Unix job.
                #[cfg(windows)]
                let _ = Command::new("taskkill")
                    .args(["/PID", &r.value, "/T", "/F"])
                    .output();
            }
            Ok(())
        }
    }
}

/// What a release did: `freed` are gone from disk and from the registry; `kept` were
/// refused by `free_one` (with its reason) and stay recorded, so `resources` and doctor
/// still show them.
#[derive(Debug, Default)]
pub struct Released {
    pub freed: Vec<Resource>,
    pub kept: Vec<(Resource, String)>,
}

pub fn release(dir: &Path, run: Option<&str>) -> Released {
    let items = load(dir);
    let mut released = Released::default();
    let mut remainder = Vec::new();
    for item in items {
        if run.is_some_and(|run| run != item.run) {
            remainder.push(item);
            continue;
        }
        match free_one(&item) {
            Ok(()) => released.freed.push(item),
            Err(reason) => {
                remainder.push(item.clone());
                released.kept.push((item, reason));
            }
        }
    }
    if !released.freed.is_empty() {
        let _ = save(dir, &remainder);
    }
    released
}

pub fn leaked<'a>(items: &'a [Resource], live: &HashSet<String>) -> Vec<&'a Resource> {
    items.iter().filter(|r| !live.contains(&r.run)).collect()
}

pub fn age_secs(r: &Resource, now: u64) -> u64 {
    now.saturating_sub(r.created_unix)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn res(kind: Kind, value: &str, run: &str) -> Resource {
        Resource {
            kind,
            value: value.to_string(),
            run: run.to_string(),
            created_unix: 100,
        }
    }

    #[test]
    fn alloc_load_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let store = dir.path().join("store");
        let r = alloc(&store, Kind::Tmp, "/tmp/x", "run1").unwrap();
        assert_eq!(r.kind, Kind::Tmp);
        assert_eq!(r.value, "/tmp/x");
        assert_eq!(r.run, "run1");
        assert!(r.created_unix > 0);
        assert_eq!(load(&store), vec![r]);
        assert_eq!(store_path(&store), store.join("resources.json"));
    }

    #[test]
    fn alloc_dedups_same_kind_value_run() {
        let dir = tempfile::tempdir().unwrap();
        let a = alloc(dir.path(), Kind::Port, "3000", "run1").unwrap();
        let b = alloc(dir.path(), Kind::Port, "3000", "run1").unwrap();
        assert_eq!(a, b);
        assert_eq!(load(dir.path()).len(), 1);
        // Different run is not a duplicate.
        alloc(dir.path(), Kind::Port, "3000", "run2").unwrap();
        assert_eq!(load(dir.path()).len(), 2);
    }

    #[test]
    fn release_run_frees_only_that_run() {
        let store = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        let a_dir = data.path().join("a_dir");
        let a_file = data.path().join("a_file");
        let b_dir = data.path().join("b_dir");
        fs::create_dir(&a_dir).unwrap();
        fs::write(&a_file, b"x").unwrap();
        fs::create_dir(&b_dir).unwrap();
        alloc(store.path(), Kind::Tmp, a_dir.to_str().unwrap(), "A").unwrap();
        alloc(store.path(), Kind::Tmp, a_file.to_str().unwrap(), "A").unwrap();
        alloc(store.path(), Kind::Tmp, b_dir.to_str().unwrap(), "B").unwrap();
        let released = release(store.path(), Some("A"));
        assert_eq!(released.freed.len(), 2);
        assert!(released.kept.is_empty());
        assert!(!a_dir.exists());
        assert!(!a_file.exists());
        assert!(b_dir.exists());
        let left = load(store.path());
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].run, "B");
    }

    #[test]
    fn release_none_frees_all() {
        let dir = tempfile::tempdir().unwrap();
        alloc(dir.path(), Kind::Port, "3000", "A").unwrap();
        alloc(dir.path(), Kind::Port, "3001", "B").unwrap();
        let released = release(dir.path(), None);
        assert_eq!(released.freed.len(), 2);
        assert!(load(dir.path()).is_empty());
    }

    #[test]
    fn absolute_value_joins_relative_paths_only_for_path_kinds() {
        let cwd = Path::new("/work");
        assert_eq!(
            absolute_value(Kind::Worktree, "wt/a", cwd),
            cwd.join("wt/a").display().to_string()
        );
        assert_eq!(absolute_value(Kind::Port, "3000", cwd), "3000");
        assert_eq!(absolute_value(Kind::Proc, "42", cwd), "42");
        let abs = std::env::temp_dir().join("x").display().to_string();
        assert_eq!(absolute_value(Kind::Tmp, &abs, cwd), abs);
    }

    fn git_ok(dir: &Path, args: &[&str]) {
        let status = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(["-c", "user.name=t", "-c", "user.email=t@t"])
            .args(args)
            .status()
            .expect("run git");
        assert!(status.success(), "git {args:?}");
    }

    /// A repo with one linked worktree on its own branch, committed past the base.
    fn repo_with_worktree(base: &Path) -> (PathBuf, PathBuf) {
        let repo = base.join("repo");
        fs::create_dir(&repo).unwrap();
        git_ok(&repo, &["init", "-q"]);
        git_ok(&repo, &["commit", "-q", "--allow-empty", "-m", "base"]);
        let wt = base.join("wt");
        git_ok(
            &repo,
            &["worktree", "add", "-q", "-b", "work", wt.to_str().unwrap()],
        );
        fs::write(wt.join("done.txt"), "x").unwrap();
        git_ok(&wt, &["add", "done.txt"]);
        git_ok(&wt, &["commit", "-q", "-m", "work"]);
        (repo, wt)
    }

    #[test]
    fn dirty_worktree_is_kept_and_stays_recorded() {
        let base = tempfile::tempdir().unwrap();
        let store = tempfile::tempdir().unwrap();
        let (_repo, wt) = repo_with_worktree(base.path());
        fs::write(wt.join("uncommitted.txt"), "keep me").unwrap();
        alloc(store.path(), Kind::Worktree, wt.to_str().unwrap(), "R").unwrap();
        let released = release(store.path(), Some("R"));
        assert!(released.freed.is_empty());
        assert_eq!(released.kept.len(), 1);
        assert!(wt.join("uncommitted.txt").exists());
        assert_eq!(load(store.path()).len(), 1);
    }

    #[test]
    fn clean_worktree_is_removed_through_git_and_its_branch_kept() {
        let base = tempfile::tempdir().unwrap();
        let store = tempfile::tempdir().unwrap();
        let (repo, wt) = repo_with_worktree(base.path());
        alloc(store.path(), Kind::Worktree, wt.to_str().unwrap(), "R").unwrap();
        let released = release(store.path(), Some("R"));
        assert_eq!(released.freed.len(), 1, "kept: {:?}", released.kept);
        assert!(!wt.exists());
        // The branch, and so every commit made in the worktree, survives.
        git_ok(&repo, &["rev-parse", "--verify", "-q", "refs/heads/work"]);
        let list = git(&repo, &["worktree", "list", "--porcelain"]).unwrap();
        assert_eq!(list.matches("worktree ").count(), 1, "{list}");
        assert!(load(store.path()).is_empty());
    }

    #[test]
    fn dirty_clone_is_kept() {
        let base = tempfile::tempdir().unwrap();
        let store = tempfile::tempdir().unwrap();
        let clone = base.path().join("clone");
        fs::create_dir(&clone).unwrap();
        git_ok(&clone, &["init", "-q"]);
        fs::write(clone.join("new.txt"), "x").unwrap();
        alloc(store.path(), Kind::Clone, clone.to_str().unwrap(), "R").unwrap();
        let released = release(store.path(), Some("R"));
        assert_eq!(released.kept.len(), 1);
        assert!(clone.join("new.txt").exists());
    }

    #[test]
    fn leaked_returns_only_dead_runs() {
        let items = vec![
            res(Kind::Tmp, "/a", "live1"),
            res(Kind::Tmp, "/b", "dead1"),
            res(Kind::Tmp, "/c", "dead2"),
        ];
        let live: HashSet<String> = ["live1".to_string()].into_iter().collect();
        let out = leaked(&items, &live);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].value, "/b");
        assert_eq!(out[1].value, "/c");
    }

    #[test]
    fn load_corrupt_returns_empty() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(store_path(dir.path()), "not json {{").unwrap();
        assert!(load(dir.path()).is_empty());
        // Missing file also returns empty.
        let empty = tempfile::tempdir().unwrap();
        assert!(load(empty.path()).is_empty());
    }

    #[test]
    fn kind_parse_and_age() {
        assert_eq!(Kind::parse("worktree").unwrap(), Kind::Worktree);
        assert_eq!(Kind::parse("proc").unwrap().as_str(), "proc");
        assert!(Kind::parse("bogus").is_err());
        let r = res(Kind::Tmp, "/a", "run1");
        assert_eq!(age_secs(&r, 150), 50);
        assert_eq!(age_secs(&r, 50), 0);
    }
}

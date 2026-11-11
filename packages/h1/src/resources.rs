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

pub fn free_one(r: &Resource) {
    match r.kind {
        Kind::Worktree => {
            let path = Path::new(&r.value);
            if path.exists() {
                if let Some(parent) = path.parent() {
                    let _ = Command::new("git")
                        .args(["worktree", "remove", "--force", &r.value])
                        .current_dir(parent)
                        .output();
                }
                if path.exists() {
                    let _ = fs::remove_dir_all(path);
                }
            }
        }
        Kind::Clone | Kind::Tmp => {
            let path = Path::new(&r.value);
            if path.is_dir() {
                let _ = fs::remove_dir_all(path);
            } else if path.is_file() {
                let _ = fs::remove_file(path);
            }
        }
        Kind::Port => {}
        Kind::Proc =>
        {
            #[cfg(unix)]
            if r.value.parse::<i64>().is_ok() {
                let _ = Command::new("kill").arg(&r.value).output();
            }
        }
    }
}

pub fn release(dir: &Path, run: Option<&str>) -> Vec<Resource> {
    let items = load(dir);
    let mut freed = Vec::new();
    let mut remainder = Vec::new();
    for item in items {
        if run.is_none() || run == Some(item.run.as_str()) {
            freed.push(item);
        } else {
            remainder.push(item);
        }
    }
    for item in &freed {
        free_one(item);
    }
    if !freed.is_empty() {
        let _ = save(dir, &remainder);
    }
    freed
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
        let freed = release(store.path(), Some("A"));
        assert_eq!(freed.len(), 2);
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
        let freed = release(dir.path(), None);
        assert_eq!(freed.len(), 2);
        assert!(load(dir.path()).is_empty());
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

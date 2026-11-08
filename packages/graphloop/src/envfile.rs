//! `--env-file` loading: extra `${env.NAME}` values from dotenv files.
//!
//! Lookup order for `${env.NAME}` when a lab is opened: the real process environment first,
//! then the loaded files — explicit `--env-file` files in command-line order (an earlier file
//! wins over a later one), then the implicit `.env` beside the `.yah` file (unless
//! `--no-env-file` was passed). The same file values are handed to vault provider CLIs as
//! their bootstrap environment (see `Vaults::with_command_env`), so a token such as
//! `OP_SERVICE_ACCOUNT_TOKEN` or `BW_SESSION` can live in an env file instead of being
//! exported in the shell. Values from these files are never printed.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};

use crate::vault::parse_dotenv;

/// The merged contents of every loaded env file. First occurrence of a name wins.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct EnvFiles {
    entries: Vec<(String, String)>,
}

impl EnvFiles {
    /// Load `explicit` files in order, then the implicit `.env` in the `.yah` file's directory
    /// when `include_implicit` is set and that file exists. An explicit file that cannot be
    /// read is an error; a missing implicit file is not.
    pub fn load(yah_file: &Path, explicit: &[PathBuf], include_implicit: bool) -> Result<Self, String> {
        let mut paths: Vec<PathBuf> = explicit.to_vec();
        if include_implicit {
            if let Some(dir) = yah_file.parent() {
                let implicit = dir.join(".env");
                if implicit.is_file() {
                    paths.push(implicit);
                }
            }
        }
        let mut out = EnvFiles::default();
        for path in &paths {
            let text = std::fs::read_to_string(path).map_err(|e| format!("cannot read env file {}: {e}", path.display()))?;
            out.absorb(&parse_dotenv(&text));
        }
        Ok(out)
    }

    /// Build a set directly from entries (first occurrence wins), for tests and adapters.
    pub fn from_entries(entries: Vec<(String, String)>) -> Self {
        let mut out = EnvFiles::default();
        for (name, value) in entries {
            out.push(name, value);
        }
        out
    }

    fn absorb(&mut self, map: &HashMap<String, String>) {
        // `parse_dotenv` returns a map, so order within one file is lost; keys are distinct
        // within a file, so only cross-file priority matters and first-wins preserves it.
        for (name, value) in map {
            self.push(name.clone(), value.clone());
        }
    }

    fn push(&mut self, name: String, value: String) {
        if !self.entries.iter().any(|(n, _)| n == &name) {
            self.entries.push((name, value));
        }
    }

    /// The value from the loaded files only (no process environment).
    pub fn get(&self, name: &str) -> Option<String> {
        self.entries.iter().find(|(n, _)| n == name).map(|(_, v)| v.clone())
    }

    /// Merged lookup: the real environment (via `real`) first, then the loaded files.
    pub fn lookup(&self, name: &str, real: &dyn Fn(&str) -> Option<String>) -> Option<String> {
        real(name).or_else(|| self.get(name))
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// Bootstrap environment for vault provider CLIs, sorted by name for determinism.
    pub fn command_env(&self) -> Vec<(String, String)> {
        self.entries.iter().cloned().collect::<BTreeMap<_, _>>().into_iter().collect()
    }
}

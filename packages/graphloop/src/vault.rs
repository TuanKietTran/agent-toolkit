//! Secret vaults: where `${vault.NAME.KEY}` values come from.
//!
//! A `vault "NAME" { provider = ... }` block only describes WHERE a secret lives. Nothing is read
//! at parse, check or plan time: the value is fetched when `graphloop up` opens a lab, held in
//! memory for that run, handed to the program through its ENVIRONMENT (never a command line, which
//! every process on the machine can read) and scrubbed from every message graphloop prints.
//!
//! Adapters are listed in [`PROVIDERS`]; `schema` validates a vault block against that table, so
//! adding an adapter means one table row plus one arm in [`Vaults::fetch`].

use crate::diag::suggest;
use crate::spec::Vault;
use std::cell::RefCell;
use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// One adapter: its name, the optional keys a `vault` block may carry for it, the required ones,
/// and the external program it needs on PATH (`""` when it needs none: `dotenv` reads a file,
/// `env` reads the process environment, and `command` uses the vault block's own argv).
/// `vault status` readiness is derived from this table: a CLI provider is ready iff its
/// program (or the configured `command` override for it) is found on PATH.
pub struct ProviderInfo {
    pub name: &'static str,
    pub keys: &'static [&'static str],
    pub required: &'static [&'static str],
    pub summary: &'static str,
    pub program: &'static str,
}

pub const PROVIDERS: &[ProviderInfo] = &[
    ProviderInfo { name: "dotenv", keys: &["path"], required: &[], summary: "KEY=VALUE file; path is relative to the .yah file (default .env)", program: "" },
    ProviderInfo { name: "env", keys: &[], required: &[], summary: "the process environment", program: "" },
    ProviderInfo { name: "command", keys: &["command"], required: &["command"], summary: "any CLI: an argv list where {ref} and {key} are substituted; the value is its stdout", program: "" },
    ProviderInfo { name: "1password", keys: &["account"], required: &[], summary: "1Password CLI: op read <ref> (ref is an op://vault/item/field URI)", program: "op" },
    ProviderInfo { name: "bitwarden", keys: &[], required: &[], summary: "Bitwarden CLI: bw get password|username|notes|uri|totp <item>, or <item>#<field> for a custom field (needs BW_SESSION / bw unlock)", program: "bw" },
    ProviderInfo { name: "bitwarden-secrets", keys: &[], required: &[], summary: "Bitwarden Secrets Manager CLI: bws secret get <id>; the value is the JSON field value", program: "bws" },
    ProviderInfo { name: "keychain", keys: &["account"], required: &[], summary: "macOS keychain: security find-generic-password -s <ref> -w", program: "security" },
];

pub fn provider(name: &str) -> Option<&'static ProviderInfo> {
    PROVIDERS.iter().find(|p| p.name == name)
}

pub fn provider_names() -> Vec<&'static str> {
    PROVIDERS.iter().map(|p| p.name).collect()
}

/// Secret values shorter than this are not scrubbed from text: replacing a 1-2 character value
/// would mangle every message.
const MIN_SCRUB_LEN: usize = 3;

/// Replace every known secret value in `text` with `***`.
pub fn scrub(text: &str, secrets: &[String]) -> String {
    let mut out = text.to_owned();
    let mut sorted: Vec<&String> = secrets.iter().filter(|s| s.len() >= MIN_SCRUB_LEN).collect();
    sorted.sort_by_key(|s| std::cmp::Reverse(s.len()));
    for s in sorted {
        out = out.replace(s.as_str(), "***");
    }
    out
}

/// Parse `KEY=VALUE` lines: `#` comments, optional `export `, single quotes (raw), double quotes
/// (`\n`, `\"`, `\\` escapes), an unquoted value ends at ` #`. No interpolation, no multi-line values.
pub fn parse_dotenv(text: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let line = line.strip_prefix("export ").map(str::trim_start).unwrap_or(line);
        let Some((key, value)) = line.split_once('=') else { continue };
        let key = key.trim();
        if key.is_empty() || !key.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-')) {
            continue;
        }
        let value = value.trim();
        let parsed = if let Some(rest) = value.strip_prefix('"') {
            let mut s = String::new();
            let mut chars = rest.chars();
            while let Some(c) = chars.next() {
                match c {
                    '"' => break,
                    '\\' => match chars.next() {
                        Some('n') => s.push('\n'),
                        Some('t') => s.push('\t'),
                        Some(other) => s.push(other),
                        None => s.push('\\'),
                    },
                    other => s.push(other),
                }
            }
            s
        } else if let Some(rest) = value.strip_prefix('\'') {
            rest.split('\'').next().unwrap_or("").to_owned()
        } else {
            match value.find(" #") {
                Some(i) => value[..i].trim_end().to_owned(),
                None => value.to_owned(),
            }
        };
        out.insert(key.to_owned(), parsed);
    }
    out
}

/// Run `argv` (no shell), return stdout without its trailing newline. Errors carry the program
/// name and the first line of stderr (scrubbed by the caller), never the arguments.
pub fn run_command(argv: &[String], extra_env: &[(String, String)], timeout: Duration) -> Result<String, String> {
    let (program, args) = argv.split_first().ok_or_else(|| "empty command".to_owned())?;
    let name = Path::new(program).file_name().and_then(|n| n.to_str()).unwrap_or(program).to_owned();
    let mut child = Command::new(program)
        .args(args)
        .envs(extra_env.iter().cloned())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("could not run {name}: {e}"))?;
    let mut stdout = child.stdout.take().expect("piped stdout");
    let mut stderr = child.stderr.take().expect("piped stderr");
    let out_reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stdout.read_to_end(&mut buf);
        buf
    });
    let err_reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stderr.read_to_end(&mut buf);
        buf
    });
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("{name} did not finish within {}s", timeout.as_secs()));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(20)),
            Err(e) => return Err(format!("waiting for {name}: {e}")),
        }
    };
    let out = out_reader.join().unwrap_or_default();
    let err = err_reader.join().unwrap_or_default();
    if !status.success() {
        let first = String::from_utf8_lossy(&err).lines().next().unwrap_or("").trim().chars().take(160).collect::<String>();
        return Err(if first.is_empty() { format!("{name} exited with {status}") } else { format!("{name} exited with {status}: {first}") });
    }
    let text = String::from_utf8(out).map_err(|_| format!("{name} printed bytes that are not UTF-8"))?;
    Ok(text.trim_end_matches(['\n', '\r']).to_owned())
}

/// The vaults of one run. Values are cached in memory only, so a key used by many labs is fetched
/// once, and [`Vaults::values`] lists what to scrub from output.
pub struct Vaults<'a> {
    vaults: &'a [Vault],
    base_dir: PathBuf,
    env: &'a dyn Fn(&str) -> Option<String>,
    command_env: Vec<(String, String)>,
    timeout: Duration,
    cache: RefCell<HashMap<(String, String), String>>,
    files: RefCell<HashMap<PathBuf, HashMap<String, String>>>,
}

impl<'a> Vaults<'a> {
    /// `base_dir` is the directory of the `.yah` file; `env` reads the process environment.
    pub fn new(vaults: &'a [Vault], base_dir: PathBuf, env: &'a dyn Fn(&str) -> Option<String>) -> Self {
        Vaults { vaults, base_dir, env, command_env: Vec::new(), timeout: Duration::from_secs(30), cache: RefCell::new(HashMap::new()), files: RefCell::new(HashMap::new()) }
    }

    /// Extra environment for provider CLIs (for example `OP_SERVICE_ACCOUNT_TOKEN`).
    pub fn with_command_env(mut self, env: Vec<(String, String)>) -> Self {
        self.command_env = env;
        self
    }

    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    /// Every value fetched so far, for [`scrub`].
    pub fn values(&self) -> Vec<String> {
        self.cache.borrow().values().cloned().collect()
    }

    /// The secret for `${vault.NAME.KEY}`. Errors name the vault, key and provider, never a value.
    pub fn get(&self, name: &str, key: &str) -> Result<String, String> {
        let cache_key = (name.to_owned(), key.to_owned());
        if let Some(v) = self.cache.borrow().get(&cache_key) {
            return Ok(v.clone());
        }
        let vault = self.vaults.iter().find(|v| v.name == name).ok_or_else(|| format!("vault {name:?} is not declared"))?;
        let reference = vault.secrets.iter().find(|(k, _)| k == key).map(|(_, r)| r.clone()).unwrap_or_else(|| key.to_owned());
        let value = self.fetch(vault, key, &reference).map_err(|e| format!("vault {name:?} ({}): key {key:?}: {e}", vault.provider))?;
        if value.is_empty() {
            return Err(format!("vault {name:?} ({}): key {key:?}: the value is empty", vault.provider));
        }
        self.cache.borrow_mut().insert(cache_key, value.clone());
        Ok(value)
    }

    fn fetch(&self, vault: &Vault, key: &str, reference: &str) -> Result<String, String> {
        match vault.provider.as_str() {
            "dotenv" => self.fetch_dotenv(vault, reference),
            "env" => (self.env)(reference).ok_or_else(|| format!("environment variable {reference} is not set")),
            "command" => {
                let argv: Vec<String> = vault.command.iter().map(|a| a.replace("{ref}", reference).replace("{key}", key)).collect();
                run_command(&argv, &self.command_env, self.timeout).map_err(|e| scrub(&e, &self.values()))
            }
            other => Err(format!("provider {other:?} is not available in this build")),
        }
    }

    fn fetch_dotenv(&self, vault: &Vault, reference: &str) -> Result<String, String> {
        let raw = vault.path.as_deref().unwrap_or(".env");
        let path = if let Some(rest) = raw.strip_prefix("~/") {
            (self.env)("HOME").map(|h| PathBuf::from(h).join(rest)).ok_or_else(|| "HOME is not set".to_owned())?
        } else if Path::new(raw).is_absolute() {
            PathBuf::from(raw)
        } else {
            self.base_dir.join(raw)
        };
        if !self.files.borrow().contains_key(&path) {
            let text = std::fs::read_to_string(&path).map_err(|e| format!("cannot read {}: {e}", path.display()))?;
            self.files.borrow_mut().insert(path.clone(), parse_dotenv(&text));
        }
        let files = self.files.borrow();
        let map = &files[&path];
        match map.get(reference) {
            Some(v) => Ok(v.clone()),
            None => {
                let hint = suggest(reference, map.keys().map(String::as_str)).map(|s| format!(" Did you mean {s:?}?")).unwrap_or_default();
                Err(format!("{reference} is not set in {}.{hint}", path.display()))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vault(provider: &str) -> Vault {
        Vault { name: "v".into(), provider: provider.into(), path: None, account: None, command: Vec::new(), secrets: Vec::new(), line: 1 }
    }

    #[test]
    fn dotenv_parsing_handles_quotes_comments_and_export() {
        let m = parse_dotenv("# c\nA=1\nexport B = two words # note\nC=\"x\\ny\\\"z\"\nD='raw $HOME #not'\nbad line\n=nokey\nE=\n");
        assert_eq!(m["A"], "1");
        assert_eq!(m["B"], "two words");
        assert_eq!(m["C"], "x\ny\"z");
        assert_eq!(m["D"], "raw $HOME #not");
        assert_eq!(m["E"], "");
        assert!(!m.contains_key("bad line"));
    }

    #[test]
    fn scrub_replaces_longest_first_and_ignores_tiny_values() {
        let secrets = vec!["abc".to_owned(), "abcdef".to_owned(), "x".to_owned()];
        assert_eq!(scrub("key=abcdef and abc and x", &secrets), "key=*** and *** and x");
    }

    #[test]
    fn dotenv_vault_reads_relative_to_the_yah_directory() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("fleet.env"), "TOKEN=s3cret-token\n").unwrap();
        let mut v = vault("dotenv");
        v.path = Some("fleet.env".into());
        let vs = [v];
        let env = |_: &str| None;
        let vaults = Vaults::new(&vs, dir.path().to_path_buf(), &env);
        assert_eq!(vaults.get("v", "TOKEN").unwrap(), "s3cret-token");
        assert_eq!(vaults.values(), vec!["s3cret-token".to_owned()]);
    }

    #[test]
    fn dotenv_missing_key_suggests_a_close_name_without_values() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(".env"), "ANTHROPIC_API_KEY=sk-live-123456\n").unwrap();
        let vs = [vault("dotenv")];
        let env = |_: &str| None;
        let vaults = Vaults::new(&vs, dir.path().to_path_buf(), &env);
        let err = vaults.get("v", "ANTHROPIC_API_KEI").unwrap_err();
        assert!(err.contains("Did you mean \"ANTHROPIC_API_KEY\""), "{err}");
        assert!(!err.contains("sk-live-123456"), "{err}");
    }

    #[test]
    fn dotenv_missing_file_is_an_error_naming_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let vs = [vault("dotenv")];
        let env = |_: &str| None;
        let err = Vaults::new(&vs, dir.path().to_path_buf(), &env).get("v", "X").unwrap_err();
        assert!(err.contains(".env") && err.contains("cannot read"), "{err}");
    }

    #[test]
    fn env_vault_reads_the_environment_and_secrets_map_renames_keys() {
        let mut v = vault("env");
        v.secrets = vec![("API".into(), "REAL_NAME".into())];
        let vs = [v];
        let env = |n: &str| (n == "REAL_NAME").then(|| "from-env".to_owned());
        let vaults = Vaults::new(&vs, PathBuf::from("."), &env);
        assert_eq!(vaults.get("v", "API").unwrap(), "from-env");
        assert!(vaults.get("v", "OTHER").unwrap_err().contains("OTHER is not set"));
    }

    #[test]
    fn command_vault_substitutes_ref_and_key_and_trims_the_newline() {
        let mut v = vault("command");
        v.command = vec!["sh".into(), "-c".into(), "printf '%s:%s\\n' \"$0\" \"$1\"".into(), "{ref}".into(), "{key}".into()];
        v.secrets = vec![("K".into(), "the-ref".into())];
        let vs = [v];
        let env = |_: &str| None;
        let vaults = Vaults::new(&vs, PathBuf::from("."), &env);
        assert_eq!(vaults.get("v", "K").unwrap(), "the-ref:K");
    }

    #[test]
    fn command_vault_failure_reports_stderr_but_not_the_arguments() {
        let mut v = vault("command");
        v.command = vec!["sh".into(), "-c".into(), "echo 'item not found' >&2; exit 3".into(), "SECRET-REF-ARG".into()];
        let vs = [v];
        let env = |_: &str| None;
        let err = Vaults::new(&vs, PathBuf::from("."), &env).get("v", "K").unwrap_err();
        assert!(err.contains("item not found") && err.contains("exited"), "{err}");
        assert!(!err.contains("SECRET-REF-ARG"), "{err}");
    }

    #[test]
    fn command_vault_times_out() {
        let mut v = vault("command");
        v.command = vec!["sleep".into(), "5".into()];
        let vs = [v];
        let env = |_: &str| None;
        let err = Vaults::new(&vs, PathBuf::from("."), &env).with_timeout(Duration::from_millis(200)).get("v", "K").unwrap_err();
        assert!(err.contains("did not finish"), "{err}");
    }

    #[test]
    fn empty_value_is_an_error_and_unknown_vault_is_reported() {
        let mut v = vault("env");
        v.secrets = vec![];
        let vs = [v];
        let env = |n: &str| (n == "EMPTY").then(String::new);
        let vaults = Vaults::new(&vs, PathBuf::from("."), &env);
        assert!(vaults.get("v", "EMPTY").unwrap_err().contains("empty"));
        assert!(vaults.get("nope", "K").unwrap_err().contains("not declared"));
    }

    #[test]
    fn values_are_cached_so_a_second_get_does_not_rerun_the_provider() {
        let dir = tempfile::tempdir().unwrap();
        let counter = dir.path().join("count");
        let mut v = vault("command");
        v.command = vec!["sh".into(), "-c".into(), format!("echo run >> {}; echo value", counter.display())];
        let vs = [v];
        let env = |_: &str| None;
        let vaults = Vaults::new(&vs, dir.path().to_path_buf(), &env);
        vaults.get("v", "K").unwrap();
        vaults.get("v", "K").unwrap();
        assert_eq!(std::fs::read_to_string(&counter).unwrap().lines().count(), 1);
    }
}

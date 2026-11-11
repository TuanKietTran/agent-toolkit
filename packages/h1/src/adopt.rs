//! `h1 adopt` / `h1 attach --agent`: adopt a running foreign agent into h1.
//!
//! A foreign process has no h1 PTY, so adoption resumes its session inside a
//! new h1 session via `commands::open`. The original process is never killed
//! or signalled. An agent that is already hosted by h1 is simply attached to.

use super::*;

/// The command that resumes `rec`'s session in a new process of the same kind.
pub(crate) fn resume_command(rec: &agents::AgentRec) -> Result<Vec<OsString>> {
    match rec.kind.as_deref() {
        Some("claude") => match &rec.session_id {
            Some(id) => Ok(vec!["claude".into(), "--resume".into(), id.into()]),
            None => Err(anyhow!(
                "claude session {} has no recorded session id; cannot adopt",
                rec.pid
                    .map(|pid| pid.to_string())
                    .or_else(|| rec.name.clone())
                    .unwrap_or_else(|| "unknown".into())
            )),
        },
        Some("pi") => Ok(match &rec.session_id {
            Some(id) => vec!["pi".into(), "--session".into(), id.into()],
            None => vec!["pi".into(), "--continue".into()],
        }),
        Some("opencode") => Ok(match &rec.session_id {
            Some(id) => vec!["opencode".into(), "--session".into(), id.into()],
            None => vec!["opencode".into(), "--continue".into()],
        }),
        Some("codex") => Ok(match &rec.session_id {
            Some(id) => vec!["codex".into(), "resume".into(), id.into()],
            None => vec!["codex".into(), "resume".into(), "--last".into()],
        }),
        other => Err(anyhow!(
            "{} cannot be adopted: only claude, pi, opencode and codex support resume",
            other.unwrap_or("unknown")
        )),
    }
}

/// Find the scan record for `target`: all-digits is a pid, anything else is an
/// exact name match.
pub(crate) fn find_target<'a>(
    records: &'a [agents::AgentRec],
    target: &str,
) -> Result<&'a agents::AgentRec> {
    if !target.is_empty() && target.bytes().all(|byte| byte.is_ascii_digit()) {
        let pid: u64 = target.parse().unwrap_or(u64::MAX);
        return records
            .iter()
            .find(|rec| rec.pid == Some(pid))
            .ok_or_else(|| anyhow!("no running agent matches {target}"));
    }
    let matches: Vec<&agents::AgentRec> = records
        .iter()
        .filter(|rec| rec.name.as_deref() == Some(target))
        .collect();
    match matches.len() {
        0 => Err(anyhow!("no running agent matches {target}")),
        1 => Ok(matches[0]),
        _ => Err(anyhow!(
            "multiple running agents named {target} (pids {}); use a pid to pick one",
            matches
                .iter()
                .map(|rec| rec
                    .pid
                    .map(|pid| pid.to_string())
                    .unwrap_or_else(|| "unknown".into()))
                .collect::<Vec<_>>()
                .join(", ")
        )),
    }
}

/// Adopt the agent named by `target` (pid or name). `name` overrides the new
/// session's name; `detached` hosts it in the background instead of attaching.
pub(crate) fn run(target: &str, name: Option<String>, detached: bool) -> Result<i32> {
    let records = agents::scan(&agents::ScanOptions {
        probe: true,
        stalled_ms: 8000,
    });
    let rec = find_target(&records, target)?.clone();
    if rec.managed {
        let lab = rec.name.clone().unwrap_or_else(|| target.to_owned());
        println!("{lab} is already hosted by h1");
        return attach(AttachArgs {
            connection: SocketArgs {
                socket: None,
                name: Some(lab),
            },
            interval_ms: 100,
            terminal: None,
            agent: None,
        });
    }
    let command = resume_command(&rec)?;
    let kind = rec.kind.clone().unwrap_or_else(|| "agent".into());
    let session_name = name.unwrap_or_else(|| format!("adopt-{kind}-{}", rec.pid.unwrap_or(0)));
    if kind == "claude" {
        println!(
            "the original process is still running; this session resumes its conversation in h1 - exit the original first to avoid two writers"
        );
    } else {
        println!(
            "the original process is still running; this session resumes its conversation in h1"
        );
    }
    commands::open(OpenArgs {
        name: Some(session_name),
        title: None,
        cols: 150,
        rows: 40,
        cwd: rec.cwd.clone().map(PathBuf::from),
        env: Vec::new(),
        record: None,
        detached,
        quick_edit: false,
        terminal: None,
        timeout: 30,
        json: false,
        graph: GraphArgs::default(),
        renew: RenewArgs::default(),
        command,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rec(kind: Option<&str>, session_id: Option<&str>) -> agents::AgentRec {
        agents::AgentRec {
            kind: kind.map(str::to_owned),
            name: Some("worker".into()),
            pid: Some(42),
            session_id: session_id.map(str::to_owned),
            ..Default::default()
        }
    }

    fn strings(command: Vec<OsString>) -> Vec<String> {
        command
            .iter()
            .map(|part| part.to_string_lossy().into_owned())
            .collect()
    }

    #[test]
    fn claude_with_id_resumes_it() {
        assert_eq!(
            strings(resume_command(&rec(Some("claude"), Some("s1"))).unwrap()),
            ["claude", "--resume", "s1"]
        );
    }

    #[test]
    fn claude_without_id_errors() {
        let error = resume_command(&rec(Some("claude"), None))
            .unwrap_err()
            .to_string();
        assert_eq!(
            error,
            "claude session 42 has no recorded session id; cannot adopt"
        );
    }

    #[test]
    fn pi_with_id_uses_session() {
        assert_eq!(
            strings(resume_command(&rec(Some("pi"), Some("s2"))).unwrap()),
            ["pi", "--session", "s2"]
        );
    }

    #[test]
    fn pi_without_id_continues() {
        assert_eq!(
            strings(resume_command(&rec(Some("pi"), None)).unwrap()),
            ["pi", "--continue"]
        );
    }

    #[test]
    fn opencode_with_id_uses_session() {
        assert_eq!(
            strings(resume_command(&rec(Some("opencode"), Some("s3"))).unwrap()),
            ["opencode", "--session", "s3"]
        );
    }

    #[test]
    fn opencode_without_id_continues() {
        assert_eq!(
            strings(resume_command(&rec(Some("opencode"), None)).unwrap()),
            ["opencode", "--continue"]
        );
    }

    #[test]
    fn codex_with_id_resumes_it() {
        assert_eq!(
            strings(resume_command(&rec(Some("codex"), Some("s4"))).unwrap()),
            ["codex", "resume", "s4"]
        );
    }

    #[test]
    fn codex_without_id_resumes_last() {
        assert_eq!(
            strings(resume_command(&rec(Some("codex"), None)).unwrap()),
            ["codex", "resume", "--last"]
        );
    }

    #[test]
    fn unsupported_kind_errors() {
        let error = resume_command(&rec(Some("gemini"), Some("s5")))
            .unwrap_err()
            .to_string();
        assert_eq!(
            error,
            "gemini cannot be adopted: only claude, pi, opencode and codex support resume"
        );
    }

    #[test]
    fn missing_kind_errors() {
        let error = resume_command(&rec(None, Some("s6")))
            .unwrap_err()
            .to_string();
        assert_eq!(
            error,
            "unknown cannot be adopted: only claude, pi, opencode and codex support resume"
        );
    }
}

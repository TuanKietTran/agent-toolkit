//! Table-driven start commands for the builtin agents: `h1 claude`, `h1 pi`,
//! `h1 opencode` and `h1 codex` each start that program hosted in an h1
//! session via `commands::open`.

use super::*;

/// One builtin agent: the subcommand kind, the program it runs, and the
/// arguments the program always starts with (before any passthrough).
pub(crate) struct BuiltinAgent {
    kind: &'static str,
    program: &'static str,
    base_args: &'static [&'static str],
}

pub(crate) const BUILTIN_AGENTS: &[BuiltinAgent] = &[
    BuiltinAgent {
        kind: "claude",
        program: "claude",
        base_args: &[],
    },
    BuiltinAgent {
        kind: "pi",
        program: "pi",
        base_args: &[],
    },
    BuiltinAgent {
        kind: "opencode",
        program: "opencode",
        base_args: &[],
    },
    BuiltinAgent {
        kind: "codex",
        program: "codex",
        base_args: &[],
    },
];

/// The full command for `agent`: its program, then its base args, then the
/// user's passthrough args.
pub(crate) fn command_for(agent: &BuiltinAgent, passthrough: &[OsString]) -> Vec<OsString> {
    let mut command = Vec::with_capacity(1 + agent.base_args.len() + passthrough.len());
    command.push(OsString::from(agent.program));
    command.extend(agent.base_args.iter().map(|arg| OsString::from(*arg)));
    command.extend(passthrough.iter().cloned());
    command
}

/// Start the builtin agent `kind` in an h1 session named after the kind,
/// unless `-n` overrides it. Hosting is `commands::open`, so an
/// already-running name fails with open's existing error.
pub(crate) fn run(kind: &str, args: AgentStartArgs) -> Result<i32> {
    let agent = BUILTIN_AGENTS
        .iter()
        .find(|agent| agent.kind == kind)
        .ok_or_else(|| anyhow!("unknown builtin agent: {kind}"))?;
    let command = command_for(agent, &args.args);
    commands::open(OpenArgs {
        name: Some(args.name.unwrap_or_else(|| kind.to_string())),
        title: None,
        cols: 150,
        rows: 40,
        cwd: args.cwd,
        env: vec![],
        record: None,
        detached: args.detached,
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

    #[test]
    fn table_has_exactly_the_four_kinds_unique_and_program_matches_kind() {
        assert_eq!(BUILTIN_AGENTS.len(), 4);
        let mut kinds: Vec<&str> = BUILTIN_AGENTS.iter().map(|agent| agent.kind).collect();
        kinds.sort_unstable();
        kinds.dedup();
        assert_eq!(kinds.len(), 4, "kinds must be unique: {kinds:?}");
        assert_eq!(kinds, ["claude", "codex", "opencode", "pi"]);
        for agent in BUILTIN_AGENTS {
            assert_eq!(agent.program, agent.kind);
        }
    }

    #[test]
    fn command_for_appends_passthrough_after_base_args() {
        let agent = BuiltinAgent {
            kind: "demo",
            program: "demo-prog",
            base_args: &["--base", "x"],
        };
        let passthrough = [OsString::from("--flag"), OsString::from("value")];
        assert_eq!(
            command_for(&agent, &passthrough),
            [
                OsString::from("demo-prog"),
                OsString::from("--base"),
                OsString::from("x"),
                OsString::from("--flag"),
                OsString::from("value"),
            ]
        );
    }

    #[test]
    fn command_for_with_empty_passthrough_is_program_plus_base_args() {
        for agent in BUILTIN_AGENTS {
            assert_eq!(command_for(agent, &[]), [OsString::from(agent.program)]);
        }
        let agent = BuiltinAgent {
            kind: "demo",
            program: "demo-prog",
            base_args: &["--base"],
        };
        assert_eq!(
            command_for(&agent, &[]),
            [OsString::from("demo-prog"), OsString::from("--base")]
        );
    }
}

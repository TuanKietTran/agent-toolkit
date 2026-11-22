# h1-orchestrator

An agent-neutral skill (Pi, Claude Code, Codex) for orchestrating interactive agent
sessions hosted by [`h1`](../../packages/h1). h1 is the runtime: it hosts the sessions and
owns lifecycle, messaging, relations, events, waiting, recovery and resource cleanup. This
skill only teaches the judgment around it: when to delegate, which team, how to brief,
how to supervise, how to verify, and what to clean up. It ships no scripts.

    ./install.sh            # cargo install h1, then link the skill for every agent
    python3 ../install.py h1-orchestrator --agent pi   # link only, for one agent

`SKILL.md` is the whole skill, under 60 lines; command details stay in `h1 --help` and
the h1 README. It replaces `lab-commander`; see
[`docs/architecture/h1-skill-migration.md`](../../docs/architecture/h1-skill-migration.md).

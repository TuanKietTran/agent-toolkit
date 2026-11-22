# ADR: h1 is the orchestration runtime; a thin skill teaches orchestration

Status: accepted.

## Context

`lab-commander` combined three things: documentation of the `h1` CLI, five helper scripts
(`labctl`, `lab-team`, `lab-watch`, `lab-clean`, `lab-gui`) and orchestration advice. It
also mandated one model ("every manager and every worker is a Muse Pi lab") and a fixed
three-role team on one provider with hardcoded model ids. Meanwhile h1 grew native
relations, events, signals, waiting, recovery, resource tracking and declarative teams
([capability audit](h1-orchestration-capability-audit.md)).

Three options were considered: no skill (A), a thin skill (B), a full skill with its own
infrastructure (C).

## Decision

Option B. h1 is the source of truth for running agents. The `h1-orchestrator` skill holds
only judgment and ships no executables. `lab-commander` and all of its helpers are removed.

## Why a skill at all (not A)

The h1 CLI answers "how do I open, message, wait for, recover and clean up a session".
It cannot answer when delegation is worth its cost, which topology fits a task, what a
brief must contain, how to give concurrent editors disjoint ownership, how to tell a
finished worker from a stuck one, when to answer a worker's question yourself, or what to
verify before accepting a completion claim. Those are decisions an agent gets wrong
without guidance (over-delegating, polling screens, nudging thinking workers, trusting
`DONE`). They are not runtime features and do not belong in h1.

## Why not a full skill (not C)

Every runtime job the scripts did is native in h1 or became native with one small fix:

| Responsibility | Owner |
| --- | --- |
| Hosting PTYs, lifecycle, messaging, keys, screens | h1 |
| Relations, events, signals, waiting, state detection | h1 |
| Renew, recover, adopt | h1 |
| Resource ownership and safe cleanup | h1 (`alloc`/`gc`, fixed here) |
| Declarative teams and run manifests | h1 (`.yah`, `up`/`down`) |
| Model calls, reasoning, tools, coding, provider and model config | the agent harness |
| When to delegate, topology, briefs, ownership, supervision policy, verification, escalation | the skill |

Scripts on top of h1 had to track its CLI, were Unix-only (`pgrep`, `kill`, `sh`), and
encoded one user's model choices. Removing them removes that maintenance.

## What was removed

- `labctl` (alias), `lab-team` (fixed team, hardcoded models), `lab-watch` (screen polling),
  `lab-clean` (cleanup), `bin/lab-gui` (duplicate of `packages/lab-gui`'s own `bin`).
- Mandatory Muse, mandatory three-role team, mandatory `claude-cli` provider, handoff-file
  rules, legacy 0.1.0 CLI instructions.

## What remains

- `skills/h1-orchestrator/SKILL.md`: 46 lines (the old skill was 121 plus five scripts), no
  reference files, no command manual: it points to `h1 --help` and the h1 README. Tests keep
  it under 60 lines and model-neutral, and check every `h1` command and flag it shows
  against the real `--help`.
- `install.sh` (build h1, then link) and the shared `skills/install.py`, which now retires
  dangling links left by the old skill.

## h1 deficiency found and fixed

`h1 gc`/`release` (and `stop -n NAME`, which releases run `NAME`) deleted a recorded
worktree with uncommitted changes: `git worktree remove --force` ran in the worktree's
parent directory, usually outside the repository, failed, and was followed by
`remove_dir_all`. Relative paths were stored verbatim, so a later `gc` from another
directory could remove a different path. Smallest fix, in `src/resources.rs`: record path
values as absolute; keep any worktree or clone with uncommitted changes; remove a worktree
only through `git worktree remove` run against its own repository, never `--force`, so
the branch survives; keep refused resources on record and report them as `kept`. This is
what made removing `lab-clean` safe.

## Proposed follow-ups (not done here)

1. Deprecate the ledger commander (`spawn`, `checkpoint`, `decide`, `ledger`, `close`,
   `resume` and the `--lab`/positional forms): a second registry that duplicates
   `open`/`stop`/`renew`/`recover`, and `spawn` fails on Windows. Smallest step: mark them
   deprecated in `--help`, then remove after one release.
2. Implement or drop `reap`/`guard`; the README now marks them as planned.
3. Kill `proc` resources on Windows in `gc`; today they are only killed on Unix.
4. Guard `tests/preview_side_effects.rs` with `#[cfg(unix)]` so `cargo test` builds on Windows.
5. Fix `renew`/`recover` on Windows: a live `h1 recover` hangs, and three `tests/session.rs`
   tests fail or hang there.

## Consequences

- One runtime to maintain; the skill changes only when orchestration advice changes.
- Any harness h1 can host works with the skill; model choice moves to the orchestrating
  agent and the user.
- Users of `labctl` or `lab-*` scripts must switch to `h1` commands
  ([migration](h1-skill-migration.md)); `h1 doctor` flags leftover links.

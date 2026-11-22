---
name: h1-orchestrator
description: >
  Judgment for running agent CLIs in h1 sessions: whether to delegate at all, the smallest
  team, ownership boundaries, supervising through h1 events, verifying claimed results, and
  cleaning up only this run's resources. Use when you open or supervise h1 sessions.
---

# h1 orchestrator

h1 is the runtime: it hosts sessions and owns messaging, relations, events, waiting,
recovery and resource cleanup. The harness inside each session does the work. This skill is
only the judgment; never rebuild an h1 feature with a shell loop or a wrapper script.

1. **Discover.** Read `h1 --help` and `h1 <command> --help` (details: `packages/h1/README.md`)
   and use only what the installed binary lists; documented commands can be missing. Find
   which harnesses, models and credentials this machine has and which the user prefers.
2. **Delegate only when it pays.** Stay single-agent unless parts are independent and can
   run in parallel, the task would bury your context, or you need an independent check.
   Every session costs model calls and supervision.
3. **Smallest topology.** Manager + workers for independent parts; one editor + read-only
   explorers for heavy reading; builder + separate reviewer for risky changes; parallel
   attempts in separate worktrees when the approach is unclear. Pick each model from task
   difficulty, cost, quota and user preference; never from habit. Write a team you will
   reopen as a `.yah` file (`h1 plan`, `h1 up`).
4. **Ownership.** One editing session per worktree (absolute paths), or disjoint files
   written into every brief. Explorers stay read-only; check `git status` afterwards.
5. **Brief.** Put it in a file and send a one-line pointer. State objective, context,
   absolute cwd, what the worker owns and must not touch, dependencies, deliverables, exact
   verification commands, and a completion marker that starts a line and carries a task id
   (`LAB-DONE T7 ...`), appended to a status log that you also pass as `--resume-log`.
6. **Coordinate natively.** Record structure with `--role`/`--parent` and `h1 relation`;
   use `h1 signal` between sessions that listen for it, and `h1 send` for agents that only
   read their terminal.
7. **Supervise state, not screens.** Block on `h1 event subscribe` or `h1 watch --once`;
   read the screen only after `asking`, `stalled` or `exited`. Answer routine questions
   from the brief; escalate credentials, permissions, publishing and scope changes. Read
   the screen and status log before any retry; prefer `h1 renew`/`h1 recover` to reopening,
   and stop after two failed attempts to rethink the plan.
8. **Verify.** A marker is a claim. Read the diff, check it stays inside the worker's
   ownership, run the tests and build yourself, check integration with other workers, and
   use an independent reviewer when the risk warrants it.
9. **Finish.** Record what the run creates with `h1 alloc ... --run RUN`; `h1 stop` each
   verified session; `h1 gc --run RUN` (it keeps dirty worktrees and all branches). Never
   run `gc`/`release` without `--run`, never touch sessions, worktrees or branches you did
   not create, and never push, merge, publish or write secrets without user authorization.

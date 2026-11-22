# h1 orchestration capability audit

What h1 actually implements for agent orchestration, compared with what the former
`lab-commander` skill and its helper scripts provided. Every row was checked against the
source in `packages/h1/src` and the CLI's own `--help`, not the README alone. "Live" means
exercised against a running binary on Windows (ConPTY) during this audit; "tests" means
covered by the crate's test suite.

## Status legend

- **Implemented**: in the CLI and working.
- **Partial**: implemented with a gap that matters for orchestration.
- **Documented, not implemented**: described in the README, absent from the binary.
- **Legacy duplicate**: implemented, but a second, older way to do what another h1 command does.

## Capability matrix

| Capability | Native h1 | Former skill | Duplication | Decision |
| --- | --- | --- | --- | --- |
| Process lifecycle | Implemented: `open` (window or `--detached`), `host`, `stop` (waits for the host to exit, forgets the record), `list [--all]`, `claude`/`pi`/`opencode`/`codex` start commands. Live. | `labctl` shim (execs `h1`); `lab-clean` stop + `pgrep`/`kill` orphan sweep; legacy-CLI fallbacks | `labctl` is a pure alias; the orphan sweep re-implements what `stop` already guarantees (it waits for the host to go) and is Unix-only | Remove helpers; use `h1 open`/`stop`/`list` |
| Messaging | Implemented: `send` (`--paced`, `--file`, `-e`, `--key`), `ask`, `key`, `screen` (`--tail`, `--json`), `attach`, `foreground`. Live. | Instructions only | None | Keep native; skill teaches brief-file + one-line pointer |
| Agent relationships | Implemented: `open --role/--parent/--model`, automatic parenting through `H1_SELF`, `relation add/list/remove/graph` with `parent`, `supervises`, `depends_on`, `pairs_with`, `--cascade`. Live (cascade stop verified). | `lab-team` wired builder/explorer/advisor parent links | `lab-team` duplicates `open --parent` and `.yah` teams | Remove `lab-team` |
| Events and signals | Implemented: `event subscribe (-n ...|--all) --kind`, `signal emit/listen`; host-side push, no daemon. Live. | None | None | Keep native |
| Monitoring and waiting | Implemented: `status --json` (working/asking/stalled/gone, quiet time, exit code), `wait` (`--idle-ms`, `--for`, `--asking`, `--gone`; conditions are ANDed; returns on exit), `watch` (`--once`, `--only`, `--stalled-ms`, `--json`). Live. Partial: `wait` cannot express "first of several outcomes"; `watch` without `-n` watches only the default socket. | `lab-watch`: polls `screen` every 2 s for new `LAB-*` markers, rate/usage-limit text, idle (two equal screens), gone, timeout | Fully covered by `event subscribe`/`watch --once` (stall after the marker) plus an anchored, task-id marker regex for `wait --for` | Remove `lab-watch`; skill documents the native pattern |
| Recovery | Implemented: `renew` (new-session command, ready wait, one-line re-arm from brief + resume log), `recover [--all]` (reopen from registry; env names only), `open --brief/--resume-log/--new-cmd/--ready-regex/--auto-rearm`, `watch --rearm`, `adopt`. Partial on Windows: `list --all` shows a killed host as `dead` (live), but a live `h1 recover` of it did not return, and on `main` `tests/session.rs` has `renew_unconfirmed_rearm_exits_1` failing and two recover tests hanging there. | "reopen and rebrief" instructions; `LAB-CHECKPOINT` markers in a status log | None (the status log is exactly `--resume-log`) | Keep native; skill ties markers to the resume log |
| Lifecycle automation (`reap`, `guard`) | **Documented, not implemented**: README section exists; `h1 reap --help` and `h1 guard --help` fail; the in-tree smoke log records `BLOCKED ... missing commands: reap guard`; the `wip/h1-lifecycle/b-guard` branch has no commits. | None | None | README now marks them as planned; skill does not use them |
| Resource cleanup | Implemented: `alloc KIND VALUE --run`, `resources`, `release`/`gc [--run]`, `stop -n NAME` auto-releases run `NAME`, doctor flags leaks. **Partial (defect, fixed in this change)**: a `worktree` was force-removed and then `remove_dir_all`'d (git ran in the parent dir, usually outside the repo), destroying uncommitted work; relative paths were stored verbatim. | `lab-clean`: keeps dirty and unmerged worktrees, deletes a branch only if merged, removes `tmp/<name>` and host logs, optionally recordings, deletes Pi `handoff.json` | Mostly duplicate, but its worktree safety had no native equivalent until the fix below | Fix h1, then remove `lab-clean` |
| Team topology | Implemented: `.yah` graphspec with `check`, `fmt`, `plan`, `preview`, `graph`, `up` (run manifest, rollback on failed open), `down`, `runs`, `trace`; models named per harness. `check`/`plan` live; `up`/`down` covered by tests. | `lab-team`: fixed three-role Claude team with hardcoded model ids on one provider | Full duplicate, less general | Remove; skill teaches patterns, `.yah` for repeatable teams |
| Task delegation | Not a runtime concern | Brief file, one pointer line, marker protocol, worktree-per-editor rules | n/a | Skill (judgment) |
| Verification | Not a runtime concern | Advisor review checkpoints | n/a | Skill (judgment), topology-neutral |
| Discovery of agents | Implemented: `agents [--json] [--kind] [--publish]`, `~/.h1/harnesses.toml` rules. Not supported on Windows (relies on `ps`). | None | None | Keep native |
| Visualization | Implemented: `console` (labs, graph, models, agents, events, preview), `packages/lab-gui` (own npm `bin`) | `bin/lab-gui` wrapper | Wrapper duplicates the package's own `bin` | Remove wrapper |
| Diagnostics | Implemented: `doctor [--fix-hints]` | n/a | Doctor checked `lab-commander` links (and not Pi's skill dir) | Updated for `h1-orchestrator` and retired links |
| Ledger commander | **Legacy duplicate**: `spawn`, `checkpoint`, `decide`, `ledger`, `close`, `resume` and the positional/`--lab` forms of `send`/`ask`/`screen`/`status`/`wait` keep a second registry under `$H1_HOME` (default `~/.lab-commander`). `spawn` creates a socket file and fails on Windows. | Not referenced | Duplicates `open`/`stop`/`renew`/`recover` | Out of scope; proposed for deprecation (see the ADR) |

## Platform evidence

- Windows 10 (ConPTY), built from source: `open`, `list`, `send`, `wait --for`, `wait --asking`,
  `status --json`, `watch --once`, `event subscribe -n/--all`, `signal emit/listen`,
  `relation add/list/graph`, cascade stop, `alloc`/`gc`/`stop` resource release, `check`, `plan`.
- Linux and macOS: covered by the CI workflow and the crate's tests, not re-run in this audit.
- `tests/preview_side_effects.rs` imports `std::os::unix` without a `cfg`, so `cargo test`
  does not build on Windows; every other test target builds and runs there.
- On Windows, `tests/session.rs` fails `renew_unconfirmed_rearm_exits_1` and hangs in
  `listing_never_deletes_the_record_of_a_dead_host` and `recover_killed_fake_agent_resends_brief`,
  identically before and after this change.

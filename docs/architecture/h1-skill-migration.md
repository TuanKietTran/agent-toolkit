# Migrating from lab-commander to h1-orchestrator

`skills/lab-commander` and its helper scripts were removed. Their jobs are native `h1`
commands; the orchestration advice lives in `skills/h1-orchestrator`.

## Upgrade

```sh
git pull
skills/h1-orchestrator/install.sh     # cargo install h1; link the skill; retire old links
h1 doctor --fix-hints                 # lists anything left over, with print-only fixes
```

The installer removes old links only when they point into this checkout and their target
is gone. A link into another checkout, or a real file at one of those paths, is reported
and left in place; remove it yourself once nothing uses it.

## Command mapping

| Before | After |
| --- | --- |
| `labctl ARGS` | `h1 ARGS` |
| `lab-team up -p P --parent M --cwd D` | one `h1 open -n P-ROLE --role ROLE --parent M --cwd D -- <harness>` per role you actually need, or a `.yah` team: `h1 plan team.yah`, then `h1 up team.yah` |
| `lab-team down -p P` | `h1 stop -n NAME` per session, or `h1 down --run RUN` for a `.yah` run |
| `lab-team plan -p P` | `h1 plan team.yah` |
| `LAB_TEAM_*_MODEL` | the model in each `h1 open` command line or `.yah` `model` block |
| `lab-watch NAME [TIMEOUT]` | `h1 watch -n NAME --once --stalled-ms MS`, or `h1 event subscribe -n NAME --kind asking,stalled,exited --count 1 --timeout-ms MS`; then `h1 screen -n NAME --tail 40` |
| `lab-watch NAME --status FILE` (marker) | `h1 wait -n NAME --for '(?m)^\s*LAB-(DONE\|BLOCKED) TASKID\b' --timeout S`, or read FILE after the stall event |
| `lab-clean NAME` | `h1 stop -n NAME` (waits for the host to exit; no orphan sweep needed) |
| `lab-clean ... --into BRANCH` (worktrees) | record worktrees with `h1 alloc worktree /abs/wt --run RUN`, free them with `h1 gc --run RUN` (keeps dirty ones, keeps branches), then `git branch -d BRANCH` after merging |
| `W/tmp/NAME`, host logs, `--purge-logs` | `h1 alloc tmp /abs/path --run RUN` for anything temporary, then `h1 gc --run RUN` |
| Pi `handoff.json` deletion | not an h1 concern; the brief and status log are the state (`h1 renew` re-arms from them) |
| `lab-gui` | `node packages/lab-gui/server.mjs --open`, or `npm link` in `packages/lab-gui` for a `lab-gui` command |
| legacy 0.1.0 `host -s`/`ls` | rebuild h1 (`cargo install --locked --path packages/h1`) |

## Behaviour that changed

- No model or provider is mandated. Choose per task and per user preference.
- No fixed builder/explorer/advisor team; the skill picks the smallest topology per task.
- Supervision blocks on h1 state events instead of polling the screen every two seconds.
- Markers should carry a task id (`LAB-DONE T7 ...`) so stale or echoed markers never match.
- `h1 gc`/`release`/`stop` no longer delete a worktree or clone with uncommitted changes, and
  record relative paths as absolute.

---
name: lab-commander
description: >
  Command agent labs using agent-cli-lab and labctl. Spawn, brief, monitor,
  checkpoint, resume and close interactive agent sessions.
---

# Lab commander

Use `agent-cli-lab` to host and control PTYs. `labctl` is a compatibility shim:
it executes `agent-cli-lab` with the supplied arguments. Run `./install.sh` to
install/upgrade the package binary and link this skill plus `labctl`, `lab-clean`,
and `lab-watch` into Claude Code, Codex, and Pi.

## Binary and commands

`install.sh` runs `cargo install --locked --path <package-dir>` and prints the
installed version. Require the main-package CLI feature set: `open`,
`send --paced --file`, `status`, `watch`, `key`, and `stop`. This package currently
reports version 0.1.0 for both the older installed binary and the newer source build,
so verify the required commands with `agent-cli-lab --help` rather than relying on
version text alone. Select sessions
with `-n/--name`; consult `agent-cli-lab <command> --help` for flags. Example:

```sh
agent-cli-lab open -n worker --cwd ~/repo -- pi --no-session
agent-cli-lab send -n worker --file BRIEF.md --paced
agent-cli-lab status -n worker
agent-cli-lab stop -n worker
```

**Legacy 0.1.0:** if `agent-cli-lab --version` reports 0.1.0, use
`host -s <name> -- <cmd>` for a background host, `send -s`, `screen -s`,
`ask -s`, and `ls`; there is no `stop`, so send `/quit` or Ctrl-C twice. Run
`./install.sh` to upgrade before using the commands above.

## Commander workflow

Use `open --cwd <repo> -- pi --no-session` or `host` to start a lab; use `send`,
`screen`, `status`, `wait`, `watch`, and `stop` to control it. `labctl` forwards
all arguments unchanged. Example: `labctl open -n worker --cwd ~/repo -- pi --no-session`.

## Clean up resources

Before a lab is closed for good, archive or delete its Pi handoff (`handoff.json`)
from the session directory, so a later session reusing that directory cannot inherit
stale state. The handoff extension stores it in `ctx.sessionManager.getSessionDir()`.
Keep `notes/` and reports; remove run-specific briefs, watcher scripts, temporary
build/scratch directories, and recordings containing secrets when no longer needed.

Run `lab-clean <name> [--workspace W]` or `lab-clean --all [--workspace W]`.
It stops named sessions (`stop -n` on the main CLI; Ctrl-C fallback on 0.1.0),
removes conventional `$W/tmp/<name>` and `$W/logs/<name>` artifacts, and lists
sessions to confirm/prune sockets. It never deletes notes or arbitrary workspace
files. For unmanaged hosts, send `/quit` or Ctrl-C twice, confirm the `agent-cli-lab
host` process exited (terminate an identified orphan), then remove any leftover
socket only after confirming it is stale. Archive/delete Pi handoffs and run-owned
temp files as described below. Cancel Pi `start_job` jobs. For finished worktrees,
run `git worktree remove <path>`, `git worktree prune`, and delete the merged
per-worker branch. Keep notes and reports.

## Operating protocol

- Use one worktree per worker that edits code; keep probe workers read-only.
- Brief with one line pointing to the brief file: Enter submits immediately in Pi.
- Ignore stale markers from before the latest prompt. Check the actual screen and
  status log before deciding a worker is finished or blocked.
- Pi supports `--model provider/id`, `--thinking <level>`, `--models <list>` for
  Ctrl+P cycling, and `-na` for untrusted clones; change model in-session with
  `/model <id>`.
- Work unattended. Do not ask the user; report exact blockers to the manager.
- Interactive Pi managers must not end their turn while workers run. Monitor in a
  blocking bash loop kept below the tool timeout. Pi's `Working` spinner means busy;
  text sent while busy queues and will be delivered.
- Screens scroll (often about 50 rows) and recordings are raw ANSI. Use append-only
  `status/<name>.log` marker lines as durable checkpoints.
- Brief workers with one line pointing to a file because Enter submits immediately.
  Indent marker examples in briefs (for example, `- \`LAB-DONE result\``) to avoid
  false completion detections. Pi supports `--model provider/id`, `--thinking <lvl>`,
  `--models <list>` for Ctrl+P cycling, and `-na` for untrusted clones; switch with
  `/model <id>`. Keep `repo/`, `wt/<lab>/`, `notes/`, `status/`, `briefs/`, and `logs/`
  separate; use one worktree per editing worker.
- Use `lab-watch <name> [timeout-seconds]` to watch for idle, status markers,
  blockers, usage limits, a gone lab, or timeout.
- Do not push, publish, merge to the default branch, change visibility, or write
  secrets unless explicitly authorized.

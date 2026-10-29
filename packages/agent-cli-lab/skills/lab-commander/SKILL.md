---
name: lab-commander
description: >
  Command agent labs using agent-cli-lab. Spawn, brief, monitor,
  checkpoint, resume and close interactive agent sessions.
---

# Lab commander

Use `agent-cli-lab` to host and control interactive PTYs. `labctl` is a compatibility shim that execs `agent-cli-lab`. `install.sh` builds and installs the binary, then links this skill and `labctl`, `lab-watch`, and `lab-clean`. Requires the main CLI capability set (`open --help` succeeds).

## CLI and legacy detection

Detect the CLI by capability, not version: `agent-cli-lab open --help >/dev/null 2>&1` succeeds on the main CLI and fails on legacy 0.1.0. Main CLI examples:

```sh
agent-cli-lab open -n worker --cwd /absolute/repo -- pi --no-session
agent-cli-lab send -n worker --file /absolute/brief.md --paced
agent-cli-lab status -n worker
agent-cli-lab stop -n worker
```

Consult `agent-cli-lab <command> --help` for `open`, `send`, `status`, `watch`, `key`, `stop`, `list`, and `host` options. **Legacy 0.1.0:** use `host -s <name> -- <cmd>` (background), `send -s`, `screen -s`, `ask -s`, and `ls`; it has no stop command, so send `/quit` + Enter or Ctrl-C twice. Run `install.sh` to upgrade.

## Session workflow

1. **Open:** start a named lab with `open` or `host`; use one worktree per editing worker and keep probe workers read-only.
2. **Brief:** send exactly one line pointing to the brief file; Enter submits immediately in Pi.
3. **Monitor:** use `lab-watch <name>` or inspect screen/status. Text sent while Pi is busy queues. `Working` in its status bar means busy.
4. **Checkpoint:** at phase boundaries, record marker lines in append-only `status/<name>.log`; screens scroll and recordings are raw ANSI.
5. **Reset/restart:** reopen and rebrief with the latest task and checkpoint; never assume retained state.
6. **Clean up:** use `lab-clean` and the resource rules below.
7. **Close:** stop the lab and verify it is gone.

## Worker protocol

Work unattended; do not ask the user. Print `LAB-CHECKPOINT <done / next>` at each phase boundary. Finish with `LAB-DONE <result>` or `LAB-BLOCKED <reason>` on its own line and append the same marker to `status/<name>.log`. A marker is valid only when it matches `^\s*LAB-(DONE|BLOCKED|CHECKPOINT)[ \t]+\S`; ignore markers from before the latest prompt. Never publish, merge to main, change visibility, or write secrets unless authorized.

## Operating protocol

Pi launch flags: `--model provider/id`, `--thinking <lvl>`, `--models <list>` for Ctrl+P cycling, and `-na` for untrusted clones; change models in-session with `/model <id>`. Managers must not end their turn while workers run: monitor in blocking bash loops kept below the tool timeout. `lab-watch` detects idle, status markers, blockers, usage limits, gone sessions, and timeout.

Keep `repo/`, `wt/<lab>/`, `notes/`, `status/`, `briefs/`, and `logs/` separate. Always pass **absolute paths** to `git worktree add`; relative paths under `git -C repo` can nest worktrees in the clone. If nesting occurs, add `wt/` to `.git/info/exclude`. Indent marker examples in briefs (for example, `- \`LAB-DONE result\``) so echoed text does not trigger false detections.

## Clean up resources

Stop with `stop`, or `/quit` + Enter / Ctrl-C twice on legacy. Verify the `agent-cli-lab` host exited; after about five seconds, identify any orphan with `pgrep -f "agent-cli-lab host .*(-s|-n|--name) <name>( |$)"` and kill only that PID. Confirm with `list` (legacy: `ls`); remove a socket only when no host listens, then confirm again. `lab-clean <name> --workspace W [--cwd DIR|--session-dir DIR] [--into BRANCH]` performs safe workspace cleanup; `--session-dir DIR` selects the Pi session directory directly and takes precedence over `--cwd`; `--all` is scoped to names represented by `status/<name>.log` or `logs/<name>.*` in W.

Archive Pi `handoff.json` from the session directory into `W/logs/handoffs/` when `--cwd DIR` or `--session-dir DIR` is supplied. Remove only `W/tmp/<name>` by default; `--purge-logs` opts into deleting its recording, which may contain secrets. Keep `notes/` and reports. Remove run-owned temp scripts, generated briefs, and temp build directories when no longer needed. Cancel Pi `start_job` jobs. For clean worktrees under `W/wt/<name>` or `W/repo/wt/<name>`, remove/prune and delete the branch only if it is merged into `--into BRANCH`; otherwise skip. The helper is idempotent and never deletes notes or resources outside the workspace's own scope.

---
name: lab-commander
description: >
  Command agent labs using agent-cli-lab and labctl. Spawn, brief, monitor,
  checkpoint, resume and close interactive agent sessions.
---

# Lab commander

Use `agent-cli-lab` to host/control PTYs and `labctl` for commander-side state,
ledger, and workflows. These are different tools: `labctl` is a Python controller,
not a shim. Run `./install.sh` to link this skill and `labctl` into Claude Code,
Codex, and Pi skill locations and `~/.local/bin`.

## Binary and commands

The installer requires an independently installed `agent-cli-lab` on `PATH`; it
installs only the `labctl` script from this skill. The documented direct CLI is
the 0.1.0 interface: `run`, `host`, `send`, `ask`, `screen`, `attach`,
`foreground`, `ls`, and `socket`. Select a session with `-s/--name`. `host`
accepts `-C` (columns), `-R` (rows), and `-r` (recording); `send` accepts
`-e` (submit), `-c` (Ctrl-C), and `-d` (delay); `ask` accepts `-i` (idle wait)
and `-t` (timeout). Do not use `open`, `status`, `watch`, `key`, `stop`,
`send --paced`, or `send --file` with this version.

Typical direct session:

```sh
agent-cli-lab host -s worker -C 160 -R 50 -r logs/worker.jsonl -- pi --no-session
agent-cli-lab screen -s worker
agent-cli-lab send -s worker -e 'Read BRIEF.md and execute.'
agent-cli-lab send -s worker -c
```

For other direct options, consult `agent-cli-lab <command> --help` on the
installed binary.

## Commander workflow

`labctl` manages agent-specific launches, lab records, status, waits, resume,
and an append-only decision/checkpoint ledger under `$LABCTL_HOME` (default
`~/.lab-commander`). Its commands are `spawn`, `ask`, `screen`, `send`, `status`,
`ls`, `wait`, `checkpoint`, `decide`, `resume`, `close`, and `ledger`; use
`labctl <command> --help` for flags. Example:

```sh
labctl spawn worker --agent pi --cwd ~/repo --no-open -- pi --no-session
labctl ask worker -f BRIEF.md
labctl status worker
labctl checkpoint worker 'finished inventory; beginning edits'
labctl wait worker
labctl close worker
```

## Operating protocol

- Use one worktree per worker that edits code; keep probe workers read-only.
- Brief with one line pointing to the brief file: Enter submits immediately in Pi.
- Never end your turn while workers are running. Monitor in a blocking bash loop
  kept below the tool timeout; inspect screens and append-only status logs.
- Pi's `Working` spinner means busy. Text sent while busy queues and is delivered.
- Screens scroll and recordings are raw ANSI; preserve durable checkpoints as
  marker lines in append-only `status/<name>.log` files.
- Print and log `LAB-CHECKPOINT <done / next>` at phase boundaries. Finish with
  `LAB-DONE <result>` or `LAB-BLOCKED <reason>`; markers start at column 0.
- In briefs, indent marker examples (for example, `- \`LAB-DONE result\``) so
  echoed brief text is not mistaken for a worker result.
- Ignore stale markers from before the latest prompt. Check the actual screen and
  status log before deciding a worker is finished or blocked.
- Pi supports `--model provider/id`, `--thinking <level>`, `--models <list>` for
  Ctrl+P cycling, and `-na` for untrusted clones; change model in-session with
  `/model <id>`.
- Work unattended. Do not ask the user; report exact blockers to the manager.
- Do not push, publish, merge to the default branch, change visibility, or write
  secrets unless explicitly authorized.

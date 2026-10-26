---
name: lab-commander
description: >
  Act as commander over interactive agent CLIs (Pi, Claude Code, Codex) hosted
  in PTYs by agent-cli-lab. Spawn managers and workers with `labctl`, hand off
  work, monitor, answer their questions yourself, checkpoint to a ledger so a
  usage reset or crash resumes gracefully, and close every lab at the end. Use
  when the user says "commander", "agent cli lab", "spawn a lab/manager",
  "delegate to pi/claude/codex", or asks for a multi-agent run where they must
  not be interrupted. Not for a single small edit you can just do.
---

# Lab commander

You direct; labs execute. The user is not in the loop: you own every question.
Never relay a worker's question to the user, never end a turn on a question.
Decide (smaller, more reversible reading wins), tell the worker in one definite
message, and record it: `labctl decide <lab> <text>`.

Same harness for all three CLIs: `labctl` (stdlib Python, wraps `agent-cli-lab`).
Install once with `./install.sh`; it links this skill into Claude, Codex and Pi.

## Loop

1. **Brief** a manager once, from a file, with the goal, paths, acceptance
   criteria and the protocol below. Do not micromanage its sub-labs.
   `labctl spawn mgr --agent pi --model <id> --cwd <repo>` then `labctl ask mgr -f BRIEF.md`.
2. **Monitor** with `labctl status` and `labctl wait <lab>` (exit 0 done, 2 blocked/limit/dead, 3 timeout).
   Peek with `labctl screen <lab>`; never poll faster than every 20s.
3. **Unblock**: on `blocked`, read the screen, decide, `labctl ask` the answer.
4. **Checkpoint** at each phase boundary: `labctl checkpoint <lab> <what is finished, what is next>`.
5. **Recover**: on `limit` or `dead`, wait for the reset (or downshift the model),
   respawn the lab, then `labctl resume <lab>`. It replays the last ledger rows,
   so no finished step is redone and no checkpoint is skipped.
6. **Close**: `labctl close --all` only after the acceptance checks pass.

## Worker protocol (paste into every brief)

- Work unattended. Do not ask the user anything; ask the commander only when truly blocked.
- Print `LAB-CHECKPOINT <done / next>` at each phase boundary.
- Finish with `LAB-DONE <one-line result>` or `LAB-BLOCKED <exact reason>` on its own line.
- Never publish, merge to main, change repo visibility or write secrets: report `LAB-BLOCKED` and let the commander decide.

## Agent notes

| CLI | Launch | Model | Notes |
|---|---|---|---|
| pi | `pi` | `/model <id>` typed after boot (`--model` there) | run `/reload` after adding a model; switch labs one at a time |
| claude | `claude` | `--model <id>` | permission classifier may block publish/merge; hand those to the user |
| codex | `codex` | `--model <id>` | needs the binary on PATH, or set the adapter in `bin/labctl` |

## Guardrails

- Outward-facing or irreversible steps (publish, deprecate, visibility, secrets, merge to main)
  need the user's go-ahead in the task. If a classifier denies one, stop that step, finish
  the rest, and report it once at the end; never route around the denial.
- Keep labs on one cheap model while idle or waiting on a reset; raise it only for planning.
- Recordings (`$LABCTL_HOME/*.jsonl`) may contain secrets; do not paste them anywhere.

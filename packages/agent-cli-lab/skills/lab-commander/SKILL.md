---
name: lab-commander
description: >
  Command agent labs using agent-cli-lab. Open, brief, monitor, checkpoint and
  close interactive Pi sessions. Use when the user says "commander",
  "agent cli lab", or asks to delegate work to an interactive agent lab.
  Not for a single small edit you can just do.
---

# Lab commander

Use **agent-cli-lab only** to host and control agent sessions. `labctl` is a thin
compatibility shim that execs `agent-cli-lab`; it does not manage agents, track
state, parse completion markers, or keep a ledger. Install with `./install.sh`.

## Session workflow

1. Open a named session in the target repository:
   `agent-cli-lab open -n <name> --cwd <repo> -- pi --no-session`
2. Brief it using a file: `agent-cli-lab send -n <name> --paced --file BRIEF.md -e`
3. Monitor with `agent-cli-lab status -n <name>`, `watch -n <name>`, and
   `screen -n <name>`. Use `send -n <name> -e '<answer>'` to reply and
   `key -n <name> ...` for keys.
4. Checkpoint by sending the worker a request to record its progress in its
   response or working notes; agent-cli-lab itself does not persist a ledger.
5. On reset or restart, reopen/rebrief the session with the latest task and
   checkpoint context. Do not assume a prior session's state was retained.
6. Close sessions with `agent-cli-lab stop -n <name>` when the work is complete.

## Worker protocol

- Work unattended. Do not ask the user anything; state an exact blocker if
  unable to proceed.
- Print `LAB-CHECKPOINT <done / next>` at each phase boundary.
- Finish with `LAB-DONE <one-line result>` or `LAB-BLOCKED <exact reason>` on
  its own line.
- A marker is valid only when it matches the line-start pattern
  `^\s*LAB-(DONE|BLOCKED|CHECKPOINT)[ \t]+\S`. Ignore markers found before the
  most recent prompt sent to that worker; they belong to an earlier turn.
- Never publish, merge to main, change repository visibility, or write secrets
  unless the task explicitly authorizes it.

## Pi session notes

Launch with `pi --no-session`. Select or change the model through Pi's own
interface as needed. Use a separate named session for each concurrent worker.

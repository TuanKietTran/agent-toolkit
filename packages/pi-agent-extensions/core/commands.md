# Core commands and job kinds

## Tools

1. `start_job(kind, spec)` → `{ job_id, state, sla_s, heartbeat_s, cancelable, reversible }`
2. `job_status(job_id)` → snapshot (rare; host steers first)
3. `cancel_job(job_id)` → ack
4. `job_logs(job_id, tail)` → last N lines, bounded

## Slash commands

- `/jobs` — list jobs and states
- `/core-replay [all|pass|hang|lost|cancel|resume] [live]` — dev: scripted scenarios on an isolated supervisor. Prints the event timeline and PASS/FAIL. `live` also steers events into the session as `[replay] {job_event}`.
- `/todo [add <text>|move <id> <position>|done <id>|remove <id>|clear-done|auto on|off]` — todo queue; no argument opens the manager (also Ctrl-Shift-T).

## Job kinds

Parsed by the extension. `class`: idempotent | reversible | compensable | irreversible.

Irreversible jobs remain blocked unless the user-level `~/.pi/agent/settings.json` contains:

```json
{
  "jobs": {
    "allowIrreversible": true
  }
}
```

Run `/reload` after changing the setting. `PI_JOBS_ALLOW_IRREVERSIBLE=1` remains a process-level override.
`sla_s`: advisory completion deadline, not a hard timeout. A miss emits `timed_out` once while the process keeps running; its later exit still emits `completed` or `failed`. `keep_waiting` means leave it running; no restart or tool call is needed. Zero disables the deadline warning. `heartbeat_s`: 0 disables lost-detection by silence.

Use `interactive` for agent-cli-lab hosts/attachments, delegated agent waits, REPLs and dev servers: no completion deadline and no silence-based kill. It still reports process exit and supports cancellation. A wrapper finishing does not prove its delegated agent finished; inspect that agent's screen/result.

```json
{
  "interactive": { "sla_s": 0, "heartbeat_s": 0, "class": "idempotent", "cancelable": true },
  "shell":  { "sla_s": 60,  "heartbeat_s": 0,  "class": "idempotent",   "cancelable": true },
  "test":   { "sla_s": 120, "heartbeat_s": 0,  "class": "idempotent",   "cancelable": true },
  "watch":  { "sla_s": 3600, "heartbeat_s": 10, "class": "idempotent",  "cancelable": true },
  "deploy": { "sla_s": 180, "heartbeat_s": 0,  "class": "irreversible", "cancelable": true }
}
```

## Event options by state

```json
{
  "timed_out": ["cancel", "keep_waiting", "rollback", "inspect_logs"],
  "lost":      ["cancel", "inspect_logs", "restart"],
  "failed":    ["inspect_logs", "restart"],
  "completed": [],
  "cancelled": [],
  "progress":  [],
  "queued":    [],
  "running":   []
}
```

# h1-orchestrator design

## Before and after

```text
Before                                         After
------                                         -----
agent                                          agent
  └─ lab-commander skill                         └─ h1-orchestrator skill (judgment only)
       ├─ labctl ──────────┐                          │
       ├─ lab-team ─────────┤ shell scripts            │  plain h1 commands
       ├─ lab-watch (poll) ─┤ over h1                  ▼
       ├─ lab-clean ────────┤                     h1 (runtime: sessions, relations,
       └─ lab-gui ──────────┘                         events, wait, recover, resources,
            ▼                                         .yah teams, console, doctor)
          h1                                          ▼
            ▼                                       agent harnesses (any)
  pi --provider muse (mandated)
```

## Skill layout

```text
skills/h1-orchestrator/
├── SKILL.md                         the whole skill: nine numbered decisions, under 60 lines
├── README.md                        for humans browsing the repo
├── install.sh                       cargo install h1, then skills/install.py h1-orchestrator
└── tests/test_h1_orchestrator.py
```

There are no reference files: everything operational (flags, output formats, state
detection, recovery mechanics) is already in `h1 --help` and `packages/h1/README.md`, and
the skill points there instead of copying it. The skill keeps only what h1's documentation
cannot say: discover before use; delegate only when it pays; the smallest topology; one
editor per worktree; what a brief must contain; native coordination; supervising on state
events; verifying claims; run-scoped cleanup and authorization limits.

## Principles and how they are enforced

| Principle | Mechanism |
| --- | --- |
| h1 owns the runtime | No `bin/` or other files; a test pins the skill to `SKILL.md`, `README.md`, `install.sh`, `tests/`. Every `h1` line in the skill is checked against the binary's `--help` (command, subcommand and each long flag), so the skill cannot teach syntax h1 lacks. |
| Agent and model neutrality | A test rejects model ids, `--provider X` and named model families in the skill. Model choice is a decision rule (capability, cost, quota, credentials, preference), not a default. |
| Smallest team | Single agent is the default; each topology is tied to the situation that justifies it. |
| Supervise state, not screens | Block on `h1 event subscribe` / `h1 watch --once`; read the screen only after a state change. |
| Markers that cannot false-match | Line-anchored, task-id-scoped `LAB-*` markers; the status log is also the `--resume-log`. |
| Completion is a claim | Verification checklist (diff, ownership, tests, build, integration) and an independent reviewer for risky work. |
| Clean only your own resources | `alloc --run`, `gc --run`; unscoped `gc`/`release` never appears in a code block (tested). |

## Supervision state model

| h1 state / event | Source | Orchestrator action |
| --- | --- | --- |
| `working` | output within `--stalled-ms` | wait |
| `asking` | dialog or prompt detected at the bottom of the screen | answer within brief scope or escalate |
| `stalled` | quiet, no dialog | check marker; verify, answer once, nudge once, or renew |
| `exited` (event) / `exit_code` | program ended | read screen and status log first |
| `gone` | host not answering | `h1 recover -n NAME` if the record remains |
| `relation_ended` (event) | a related session ended | re-plan dependent work |

## Upgrade path

`skills/install.py` (run by `install.sh`) first retires links named `lab-commander`,
`labctl`, `lab-clean`, `lab-gui`, `lab-team`, `lab-watch` in the selected agents' skill
dirs and `~/.local/bin`, but only when the link points into this checkout and its target
is gone. Links into other checkouts and real files are reported and left alone. `h1 doctor`
reports any that remain, with a print-only `rm` hint.

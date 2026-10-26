# system-one: brief from the commander

You are the worker. A human (the owner) is watching and can type into this terminal at any time, and a commander (Claude) may also send you instructions through it. Treat any input here as coming from one of them. Keep screen output concise.

## What system-one is

"System 1" = a small, fast, cheap, **local** decision model (intuition), as opposed to a big model's slow reasoning ("System 2"). Everything runs locally on this machine. The long-term aim is **computer use** (fast local decisions about GUI/browser actions). Right now we only build the first slice below.

## HARD RULE (forbidden, no exceptions)

Never set up, train, evaluate, or wire system-one for **permission decisions**: approve/deny/allow of tool calls, grants, consent, confirmations, sandbox escapes. Never auto-answer any permission prompt of pi, Claude Code or anything else.

Enforce it in code, not only in docs:
- a decision-kind **allowlist** (default-deny): the library refuses any decision kind not on the list, and `permission`/`approval`/`consent`/`allow`/`deny`/`grant`/`confirm` style kinds can never be added by config;
- the data pipeline **drops** any event that is a permission decision or carries permission-mode fields, so they cannot become labels or features;
- a test that proves both.

## First decision to learn: model pick

At each decision point choose which model runs the next unit of work. Situation (the label to condition on):
- **new**: first turn of a fresh session, empty context;
- **existing**: resuming an earlier session after a gap (>= 30 min idle, or an explicit resume), prompt cache probably cold;
- **continuing**: next turn of a live session, cache warm.

Candidate models usable on this account:
- claude-cli: `claude-sonnet-5-5`, `claude-opus-5`, `claude-haiku-5-5`
- openai-codex: `gpt-5.5`, `gpt-5.6-luna`, `gpt-5.6-sol`, `gpt-6-luna`, `gpt-6-sol`, `gpt-6-astra`, `gpt-6.1-sol`
- NOT usable (rejected by the account): `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.3-codex-spark`, and `gpt-5.6-terra` errors.
Per-million-token prices for the openai-codex models are in `C:\Users\cafe\.pi\agent\models-store.json` (only read the `cost` fields of the `openai-codex` models; do not print anything else from that file).

Learn from the owner's existing work (read, do not modify):
- `D:\projects\pi-agent-extensions\usage-roundrobin.ts`: current pick logic. Key idea: hold a model for a token "quantum" so the prompt cache survives; score by price index and quota headroom.
- `D:\projects\pi-agent-extensions\core\guards\context-optimize.ts`: cheap-tier pool.
- `D:\projects\agentwatch` (`src/sources.js`): how pi / Claude Code session JSONL formats are normalized.

## Data rules (privacy)

This conversation runs through a cloud model. Raw prompts must not leave the machine.
- Sources, **read-only**: `C:\Users\cafe\.claude\projects\**\*.jsonl` (31 files, ~118 MB), `C:\Users\cafe\.pi\agent\sessions\**\*.jsonl` (3 tiny files).
- Extract **metadata only**: timestamps, model id, role, event type, token usage counts, tool names, text lengths, turn index, session id (hash it), sidechain flag. **Never** print, copy, store or send message text, prompts, tool inputs/outputs or file contents.
- Never read `auth.json` or any credential/token file.
- Do not start the agentwatch daemon (port 8787 collides with pi's OpenAI bridge). Parse the JSONL directly.
- `data/` is gitignored. Hash identifiers. Pi's own sessions are confounded by the auto round-robin switcher, so flag that; Claude Code sessions mostly reflect manual choices.

## Environment and boundaries

Windows 10, RTX 3060 12 GB, 32 GB RAM, Python 3.11, `uv`, llama.cpp (`llama-server`) installed, no torch. Use a `uv` venv inside the project. Start with small CPU models (sklearn-class): system 1 must be tiny and fast. Ask the commander before installing anything over ~500 MB (torch/CUDA).
- Work only inside `D:\projects\system-one`. Everything else is read-only. Do not modify other repos or pi settings.
- `git init` locally only: no remote, no push. Commit with `git commit -F <file>` and **no** `Co-Authored-By` or other trailer lines.
- Network only for PyPI via `uv`. Do not delete anything outside this directory.

## Milestones (do M0 and M1 now, then stop)

**M0 setup**: `src/system_one/`, `tests/`, `README.md`, `.gitignore` (with `data/`), the guard module (allowlist) and its tests, passing.

**M1 data inventory**: build a decision-point dataset from the sources above, labelled new / existing / continuing as defined, with the model actually used, context size, turn index, idle gap, tool-use counts, image presence, etc. Report: record counts per situation and per model, class balance, how permission events were dropped, confounds. Splits **must be by session** to avoid leakage.

Later (not yet): M2 baselines (majority, keep-previous-model, rule replica of usage-roundrobin), M3 small local model evaluated on held-out sessions against those baselines (report honestly if it does not beat them), M4 scenario test suite for new/existing/continuing.

## Autonomy (owner requirement)

system-one must be autonomous: its decision options never include "ask the user" (or defer, escalate, confirm, abstain, unknown). It always commits to a concrete choice and falls back deterministically when unsure. This does not relax the HARD RULE: it never answers permission prompts, and the guard refuses out-of-scope decision kinds by raising, never by asking. You, the worker, also work autonomously: decide, document, continue. See `PLAN-M3.md`.

## Reporting

Keep `STATUS.md` current: what is done, real numbers, blockers, questions. When M0 and M1 are done, write `STATUS.md` and wait for the commander. Do not claim success you have not verified by running the tests.

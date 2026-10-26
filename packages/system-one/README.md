# system-one

A tiny, local-first metadata inventory for the first model-pick slice. It is **not** a permission, approval, consent, allow/deny, grant, or confirmation system.

## M0/M1

- `src/system_one/guard.py` is a compiled, default-deny decision-kind allowlist. Only `model_pick` is accepted; config cannot add other kinds.
- `src/system_one/inventory.py` reads the local Claude Code and pi JSONL sources and writes only metadata (`data/decision_points.jsonl` and `data/inventory_summary.json`). It hashes session identifiers, measures lengths, and never stores message text, prompts, tool arguments/results, or file contents.
- Permission events and records carrying permission-mode fields are dropped before feature extraction.
- Splits are deterministic by hashed session, never by record. When run inside pi, the live `PI_SESSION_FILE` is excluded so the inventory is not self-contaminated by the run that is building it.
- Main-thread idle gaps use every non-sidechain timestamped record; a >=30-minute gap is carried from the resumed record to its next model run. Sidechain turns and junk models (`<synthetic>`, `b`) are excluded.

## M3/M4 policy distillation

`src/system_one/policy.py` is an explicit R1/R2/R3 model-pick policy. `src/system_one/student.py` distills that policy into a small decision tree exported as JSON and performs pure-Python runtime inference with validators and policy fallback. `src/system_one/scenarios.py` creates balanced IID and OOD metadata-only scenarios; `src/system_one/report.py` writes `REPORT.md` and the M3/M4 metrics.

This is **policy distillation, not learning the owner's behaviour**: the student is trained on explicit policy labels because the real history has too few switches. Complexity hints and quota headroom are caller-supplied/synthetic in this slice. No live logger has been started.

Autonomy is enforced for model picks: every successful result is a concrete usable catalog model, deterministic fallback is used when a proposal is rejected, and `NoModelAvailable` is raised only when no catalog model is available. There are no sentinel decision labels. This does not affect the permission hard rule; permission-style decisions still raise through the guard and are never answered.

The student currently copies a hand-written policy but is slower than it: latency is measured honestly in `REPORT.md`. This slice proves the harness, not a speed gain; a student is only worthwhile when later rules cannot be written by hand.

## Run

```text
uv run python -m unittest discover -s tests
PYTHONPATH=src uv run python -m system_one.inventory
PYTHONPATH=src uv run python -m system_one.reconcile
PYTHONPATH=src uv run python -m system_one.baselines
PYTHONPATH=src uv run python -m system_one.report
python -m system_one.llama_swap show
python -m system_one.llama_swap detect
```

The inventory command prints only two counts. Detailed aggregate counts are in `data/inventory_summary.json`.

## Running under llama-swap

**Infrastructure notes (how it is installed, change and restart procedure, Windows helper scripts, student-model regeneration, pending macOS list): [`infra/README.md`](infra/README.md).**

Use `python -m system_one.llama_swap show` to inspect the exact local YAML fragment, then have the commander install it into a configuration copy or the approved deployment. The integration uses a localhost-only `system_one.serve` process, advertises the single OpenAI-style model `system-one`, and keeps the owner’s running GGUF model protected by the persistent non-exclusive group. `install` is text-level, idempotent, backs up first, preserves line endings/comments, and supports `--dry-run`. This project does not touch `C:\llama-swap`, any service, or files outside the project.

## Other machines (defaults)

No llama-swap installation is required elsewhere. `system_one.client.decide()` uses in-process JSON-student/policy selection by default, uses a detected llama-swap backend when it advertises `system-one`, and silently falls back in-process on transport failure. Set `SYSTEM_ONE_BACKEND=local` to force local operation or `SYSTEM_ONE_STUDENT` to select a project-local JSON student file.

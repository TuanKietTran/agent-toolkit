# PLAN-M5: policy bug fix + llama-swap recognition (commander's plan)

Owner requirements: the decision model must be **recognised by llama-swap on this machine**; **other machines are handled by default** (no llama-swap needed). system-one stays autonomous (no ask-user option) and never handles permission decisions. All of BRIEF.md and PLAN-M3.md still apply. Work autonomously; record choices under "Decisions I made" in STATUS.md.

## M5.0 policy bug (found by the commander)
With claude-only availability and hint `medium`, R3 picks the legacy `claude-sonnet-5` instead of `claude-sonnet-5-5` because both have price_index 3.0 and ties break alphabetically. The owner's most common start (sonnet-5-5, 13 of 24 sessions) is therefore never picked. Fix: give `ModelSpec` an explicit `generation`/`legacy` notion. Legacy models are **hold-only**: R1/R2 may keep them, R3 never selects a legacy model while a non-legacy candidate exists in the usable set (at any ladder level). Add a regression test (claude-only, new, medium -> `claude-sonnet-5-5`), retrain the student, and re-run the replay.

## M5.1 `src/system_one/serve.py` (standard library only)
`python -m system_one.serve --port N [--host 127.0.0.1]`. llama-swap will start it with `${PORT}` and health-check it. Bind **127.0.0.1 only** by default. Use `ThreadingHTTPServer`.
- `GET /health` -> 200 `{"status":"ok"}`.
- `GET /v1/models` -> OpenAI-style list with the single id `system-one` (owned_by `system-one`).
- `POST /v1/decide`: body is a scenario mapping (+ optional `kind`, default `model_pick`) -> 200 with `{model, rule, reason, degraded_level, kind}`.
- `POST /v1/chat/completions`: take the last user message; parse the first JSON object in it as the scenario; reply with an OpenAI-shaped completion whose `message.content` is the Decision JSON. Support `stream: true` as one SSE data chunk then `[DONE]`. Garbage content is sanitised to defaults and still decides (autonomous).
- A `kind` other than `model_pick` -> 400 with a refusal error body (never a prompt, never a question). No catalog model available -> 503 `no_model_available`. Everything else is a 200 decision.
- Uses the student JSON if present (`SYSTEM_ONE_STUDENT` env, else `<project>/data/student_model.json`), otherwise the explicit policy: this is the default behaviour on any machine without the trained file.
- Must work when started by a Windows service as LocalSystem: resolve all paths from the package location or explicit env vars, never from the user's home or PATH.
- Access log is metadata only (method, path, status, ms). Never log request bodies.

## M5.2 `src/system_one/llama_swap.py` and CLI
`python -m system_one.llama_swap {show|detect|install|uninstall} [--config PATH] [--dry-run]`.
- `show`: print the exact YAML that would be added for this machine (absolute python path = the project's `.venv\Scripts\python.exe` when it exists, `src` path, project path), in the **same style** as the existing config (`cmd: >` blocks). Shape:
  ```yaml
    "system-one":
      cmd: >
        <venv python> -m system_one.serve --port ${PORT} --host 127.0.0.1
      env:
        - "PYTHONPATH=<project>\\src"
        - "SYSTEM_ONE_STUDENT=<project>\\data\\student_model.json"
      proxy: http://127.0.0.1:${PORT}
      checkEndpoint: /health
      ttl: 0
  groups:
    "system-one-group":
      swap: false
      exclusive: false
      persistent: true
      members:
        - "system-one"
  ```
  The group is essential: without it llama-swap would unload the owner's running GGUF model whenever the decision model is called. The commander will verify the real semantics of `swap/exclusive/persistent` on this llama-swap build (v247), so make the group fields easy to change, in one constant.
- `install`: **text-level, idempotent edit that preserves comments and formatting** (do not round-trip through a YAML dumper). Insert the entry under `models:` and merge/create the `groups:` block. Write a timestamped backup next to the file first, named `<config>.bak-<yyyymmdd-HHMMSS>-system-one`. If the entry already exists and is identical, do nothing; if it differs, replace only that entry. `--dry-run` prints a diff and changes nothing. `uninstall` removes exactly what `install` added. Refuse (with a clear message) if the file is not writable or has no `models:` key. Validate the result by parsing it with PyYAML if importable, otherwise a structural check.
- `detect`: find a llama-swap that lists `system-one`: env `LLAMA_SWAP_URL`, else probe `http://127.0.0.1:8600` and `:8080` `/v1/models` with a short timeout; print the base URL or "none".
- **Do NOT touch `C:\llama-swap`, the llama-swap service, or any file outside this project.** All tests use temp copies of a synthetic config shaped like the real one (three models with `cmd: >` blocks, `ttl`, no groups; also a variant that already has a `groups:` block and one with CRLF line endings). The commander installs it for real.

## M5.3 `src/system_one/client.py`: the default path for other machines
`decide(scenario) -> Decision`: if `SYSTEM_ONE_BACKEND=local` use in-process; if llama-swap is detected and lists `system-one` (300 ms timeout) use it over HTTP; otherwise use the in-process student/policy. Same `Decision` type either way, never raises except `NoModelAvailable`, no config needed. A failed HTTP call falls back to in-process silently (and counts it). Add a test where nothing is listening and a test with a local `serve` on an ephemeral port.

## M5.4 tests and docs
Tests: serve endpoints (ephemeral port, real HTTP), refusal of `kind=permission` style kinds with 400, 503 path, SSE shape, install/uninstall idempotency and byte-preservation of the untouched parts, CRLF preservation, existing-groups merge, dry-run changes nothing, backup file created, client fallback. README section "Running under llama-swap" and "Other machines (defaults)".

## Checkpoint
Commit locally (no trailers, no remote), update STATUS.md with real numbers, then stop and wait for the commander. Do not start the live logger.

# System One: infrastructure setup

**Hard rule, unchanged:** System One decides *model picks* and nothing else. It never decides permissions, approvals, consent, allow/deny, grants or confirmations; `src/system_one/guard.py` refuses every other decision kind, in code.

## What runs where
```
callers (the pi extension, orchestration scripts such as an s1_pick.py wrapper)
   |  system_one.client.decide(scenario)         in-process fallback if no service is reachable
   v
llama-swap  (:8600, OpenAI-style gateway, one process per local model)
   |  POST /upstream/system-one/v1/decide        plain /v1/decide is a 404 through llama-swap
   v
python -m system_one.serve --port ${PORT}        stdlib HTTP shim, localhost only, model id "system-one"
   |  loads data/student_model.json (optional), validates every student proposal against the explicit policy
   v
Decision {kind: model_pick, model, rule, reason, degraded_level}
```
`system-one` lives in llama-swap's persistent, non-exclusive group, so it never evicts a large GGUF model that the owner runs through the same gateway (`ttl: 0`, `swap: false`, `exclusive: false`, `persistent: true`).

## As installed on the Windows machine (facts checked 2026-10-13 and 2026-10-18)
- llama-swap v247 runs as the Windows service `llama-swap` (NSSM, LocalSystem): `C:\llama-swap\llama-swap.exe -config C:\llama-swap\config.yaml -listen :8600`. There is no `-watch-config`, so a config change needs a service restart (elevation required).
- `Authenticated Users` can modify `C:\llama-swap\config.yaml`, so editing the file needs no elevation. Backups are named `config.yaml.bak-<yyyymmdd-HHMMSS>-<reason>`.
- The `system-one` entry and its group are in [`windows/system-one.fragment.example.yaml`](windows/system-one.fragment.example.yaml) (generated, this machine's paths).
- Routes: OpenAI API at `:8600/v1/*`, per-model passthrough at `/upstream/<model>/<path>`, `/running`, `/unload`. The pi provider list deliberately does **not** include `system-one` (it is not a chat model).
- Decision requests carry the scenario fields (`situation`, `complexity_hint`, `headroom`, `context_tokens`, `available`, ...). A declared `kind` or `type` other than `model_pick` is refused with HTTP 400 `decision_kind_refused`.

## Change procedure (Windows)
1. `python -m system_one.llama_swap show` to inspect the fragment; `python -m system_one.llama_swap install --config <config-copy> [--dry-run]` merges it into the file you name (text-preserving; it first writes a `<name>.bak-<timestamp>-system-one` backup beside it and touches only that path), so point it at a **copy**.
2. Validate the copy without touching the service: `powershell -NoProfile -File infra\windows\validate-config.ps1 -Config <copy>` (starts a second llama-swap on port 8699; a bad config exits 1 at once. Verified 2026-10-18 on a good config and on the real failure: double-quoted YAML scalars with backslashes give `found unknown escape character`).
3. Put the copy in place, then restart only when idle: `powershell -NoProfile -File infra\windows\restart-when-idle.ps1 -ExpectModel system-one`. It waits until no model is loaded, requests elevation (a UAC prompt appears, someone must click Yes), restarts the service, checks that `system-one` is listed and **rolls back to the newest backup** if not. It refuses to run when there is no backup.
4. Check: `GET :8600/v1/models` lists `system-one`; `POST :8600/upstream/system-one/v1/decide` with `{"kind":"model_pick","situation":"new","complexity_hint":"medium"}` answers 200.

## The student model
`data/student_model.json` is optional: without it `serve.py` falls back to the explicit policy (rules R1 to R3) and every pick still passes the same validator. To create it on a machine without the owner's data: `python infra/make_student.py [output]`. It trains on synthetic scenarios and needs no personal data. Training depends on Python's string-hash order; the script pins `PYTHONHASHSEED=0`, and then three runs gave the same sha256 (checked 2026-10-18). The file currently used on the Windows machine was produced without that pin, so it is a different (equally valid) tree; it is committed as `data/student_model.json`, so a new machine can serve exactly the same tree without regenerating. `python -m system_one.report` is **not** the right tool on a new machine: it also needs `data/decision_points.jsonl` (an inventory of the local Claude Code and pi session logs) and rewrites `REPORT.md`. `data/` is gitignored except four files that are tracked because the service needs or reports them: `student_model.json` (the tree currently served; its hex strings were checked against the real session hashes: no overlap), `baseline_results.json`, `m3_m4_metrics.json` and `inventory_summary.json` (aggregates only). `decision_points.jsonl` (8,087 row-level records of the owner's own activity metadata) and `scenarios.jsonl` (synthetic, regenerable) stay local.

## macOS (Apple Silicon): pending, to be done by the owner
Nothing has been run on macOS. What is known from the code, so the work starts in the right place:
- **No infra is needed to start.** `system_one.client.decide()` uses the in-process student/policy by default and uses llama-swap only when it detects one advertising `system-one` (README, "Other machines").
- `src/system_one/llama_swap.py` is Windows-only: `_win()` rewrites every path with backslashes and the interpreter is assumed at `.venv\Scripts\python.exe`, so `show` and `install` would emit wrong paths on macOS. The fix is to build POSIX paths (`.venv/bin/python`) and keep the single-quote rule only where needed.
- The Windows helpers in `infra/windows/` (NSSM service, `C:\llama-swap`, UAC) have no macOS equivalent; a launchd job (or running `llama-swap` by hand) replaces the service, and a `sudo`-free restart replaces UAC.
- `inventory.py` and `reconcile.py` read the local Claude Code and pi session directories (Windows paths today); they are only needed for the metadata inventory, not for serving.
- Settings on the Windows box list a pi extension `~/.pi/agent/extensions/system-one/extensions/index.ts` that does not exist there; it is presumably on the Mac.

## Verified and not verified
Verified (2026-10-18): the validator on a good and a bad config; PowerShell parse of all three scripts; the watcher's refusal without a backup; student regeneration reproducibility under the pinned hash seed; the live service answering `model_pick` through `/upstream/system-one/v1/decide` and refusing other kinds. **Not verified:** the elevated restart and rollback end to end in this generalised, parameterised form (the original script from 2026-10-13 worked; this version only parses and was exercised on its refusal path), and everything on macOS.

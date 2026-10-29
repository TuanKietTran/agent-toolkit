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

## Windows deployment
- llama-swap v247 runs as the Windows service `llama-swap` (NSSM, LocalSystem): `C:\llama-swap\llama-swap.exe -config C:\llama-swap\config.yaml -listen :8600`. There is no `-watch-config`, so a config change needs a service restart (elevation required).
- `Authenticated Users` can modify `C:\llama-swap\config.yaml`, so editing the file needs no elevation. Backups are named `config.yaml.bak-<yyyymmdd-HHMMSS>-<reason>`.
- The `system-one` entry and its group are in [`windows/system-one.fragment.example.yaml`](windows/system-one.fragment.example.yaml) (example configuration).
- Routes: OpenAI API at `:8600/v1/*`, per-model passthrough at `/upstream/<model>/<path>`, `/running`, `/unload`. The pi provider list deliberately does **not** include `system-one` (it is not a chat model).
- Decision requests carry the scenario fields (`situation`, `complexity_hint`, `headroom`, `context_tokens`, `available`, ...). A declared `kind` or `type` other than `model_pick` is refused with HTTP 400 `decision_kind_refused`.

## Change procedure (Windows)
1. `python -m system_one.llama_swap show` to inspect the fragment; `python -m system_one.llama_swap install --config <config-copy> [--dry-run]` merges it into the file you name (text-preserving; it first writes a `<name>.bak-<timestamp>-system-one` backup beside it and touches only that path), so point it at a **copy**.
2. Validate the copy without touching the service: `powershell -NoProfile -File infra\windows\validate-config.ps1 -Config <copy>` (starts a second llama-swap on port 8699; a bad config exits 1).
3. Put the copy in place, then restart only when idle: `powershell -NoProfile -File infra\windows\restart-when-idle.ps1 -ExpectModel system-one`. It waits until no model is loaded, requests elevation (a UAC prompt appears, someone must click Yes), restarts the service, checks that `system-one` is listed and **rolls back to the newest backup** if not. It refuses to run when there is no backup.
4. Check: `GET :8600/v1/models` lists `system-one`; `POST :8600/upstream/system-one/v1/decide` with `{"kind":"model_pick","situation":"new","complexity_hint":"medium"}` answers 200.

## The student model
`data/student_model.json` is optional: without it `serve.py` falls back to the explicit policy (rules R1 to R3) and every pick still passes the same validator. To create it on a machine without the owner's data: `python infra/make_student.py [output]`. It trains on synthetic scenarios and needs no personal data. Training depends on Python's string-hash order; the script pins `PYTHONHASHSEED=0` for reproducible output. The committed `data/student_model.json` lets a new machine serve the same tree without regenerating it. `python -m system_one.report` generates report output and requires `data/decision_points.jsonl`, an inventory of local Claude Code and pi session logs. `data/` is gitignored except `student_model.json` and `inventory_summary.json`, which are runtime inputs. Baseline results, report metrics, and report text are generated, untracked outputs. `decision_points.jsonl` and synthetic `scenarios.jsonl` stay local.

## macOS (Apple Silicon)

- **No infra is needed to start.** `system_one.client.decide()` uses the in-process student/policy by default and uses llama-swap only when it detects one advertising `system-one` (README, "Other machines").
- `src/system_one/llama_swap.py` is Windows-only: `_win()` rewrites every path with backslashes and the interpreter is assumed at `.venv\Scripts\python.exe`, so `show` and `install` would emit wrong paths on macOS. The fix is to build POSIX paths (`.venv/bin/python`) and keep the single-quote rule only where needed.
- The Windows helpers in `infra/windows/` (NSSM service, `C:\llama-swap`, UAC) have no macOS equivalent; a launchd job (or running `llama-swap` by hand) replaces the service, and a `sudo`-free restart replaces UAC.
- `inventory.py` and `reconcile.py` read the local Claude Code and pi session directories (Windows paths today); they are only needed for the metadata inventory, not for serving.
- A pi extension can integrate with the client; serving also works without llama-swap or a pi extension.

## Validation
Use the validator and service checks above to validate configuration and model-pick behavior. Elevated restart and rollback should be tested in the target deployment environment.

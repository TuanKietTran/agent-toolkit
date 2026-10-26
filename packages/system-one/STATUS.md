# Status — M5 checkpoint fixes complete

## Decisions I made

- Marked `claude-sonnet-5` legacy/hold-only; R3 now selects non-legacy `claude-sonnet-5-5` on equal-price Claude medium ties, while R1/R2 may hold a legacy previous model.
- Treated missing or null provider headroom as **unmeasured (1.0)**, while explicit numeric zero remains exhausted. Retrained the JSON student after the feature-path fix.
- Emitted Windows-path environment scalars as YAML single-quoted values, doubling embedded apostrophes; block commands remain unquoted block scalars.
- Used only temporary synthetic configs for llama-swap mutation tests. The optional real-binary test used a temporary config and ephemeral port; it did not use the real config or port 8600.
- Did not start the live logger.

## M5.0 policy and headroom fixes

- Added generation/legacy metadata and the regression test: Claude-only availability, new, medium selects **`claude-sonnet-5-5`**.
- `Scenario.from_mapping` now defaults missing/null `claude` and `codex` headroom to 1.0. Explicit numeric values are clamped; explicit 0 still reaches degradation.
- Serve regression: a minimal `{situation:new, complexity_hint:medium}` request returns **degraded_level 0**.

## M5.1–M5.4 integration

- `serve.py`: localhost health/models/decision/chat/SSE service, autonomous malformed-input handling, 400 decision-kind refusal, and 503 empty-catalog response.
- `llama_swap.py`: text-preserving show/detect/install/uninstall, idempotency, backup, dry-run, CRLF and existing-group support. Windows env paths now parse with PyYAML and preserve backslashes, spaces, and apostrophes.
- Added dev-only `pyyaml` dependency.
- `client.py`: llama-swap autodetection with 300ms transport fallback to in-process student/policy; local override remains available.
- Optional real `C:\llama-swap\llama-swap.exe` integration test ran successfully against a temporary synthetic config and ephemeral port. No real config, service, or port 8600 was touched.

## Verification

- Full suite: **28 passed**.
- Commander autonomy audit rerun after these changes:

```text
policy  raised on 0/20000 (0.0%): {}
student raised on 0/20000 (0.0%): {}
```

- Hard cases return concrete models; only an empty catalog raises `NoModelAvailable`.
- Corrected replay: **8,087** points; continuing/existing holds **8,058/8,061 = 0.999628** for each hint; new exact matches low/medium/high **6/26, 13/26, 4/26**; union **23/26 = 0.884615**. Claude availability is Claude-only; pi uses the full catalog.
- Current report after retraining: test agreement **0.963333**, OOD **0.955000**; policy degraded test share **0.388889**. Latency test policy/student median/p99 **19.5/49.8 µs** vs **90.2/210.0 µs**; the student is slower, so this proves the harness rather than a speed gain.

## Hard rule / limits

- Only `model_pick` is accepted. Permission-style decisions are refused and never answered.
- No prompt text, tool inputs/outputs, or file contents are used or stored.
- This remains explicit policy distillation, not learning the owner's behaviour. No live logger was started.

Waiting for the commander.

# Core contexts

Numeric limits. Limits are read through `limits()` in `core/md.ts` when pi loads the extension; changes need a pi restart. Model-facing text lives in `rules.md`.

## Limits

- `context-guard`: `result_share` of the active model's context window one tool result may use; `chars_per_token` converts it to bytes; `min_bytes` floors it, `max_bytes` is pi's own ceiling (only ever tightened); `max_lines` caps lines; `head_share` of the budget keeps the head, the rest keeps the tail.
- `answer-floor`: `floor_tokens` minimum `max_tokens` restored on a request; `safety_tokens` mirrors pi's hardcoded CONTEXT_SAFETY_TOKENS; `max_auto_continues` bounds consecutive resumes.
- `context-optimize`: summary output bounds, pi's provider safety reserve, chars-per-token estimate for the prompt, and fixed request overhead.
- `todo`: `max_visible_todos` rows shown in the right panel; `max_auto_continuations` bounds consecutive auto-feed continuations per run; `max_snapshot_todos` open items listed in the queue snapshot sent to the model.

```json
{
  "context-guard": { "result_share": 0.06, "chars_per_token": 4, "min_bytes": 4000, "max_bytes": 50000, "max_lines": 400, "head_share": 0.4 },
  "answer-floor": { "floor_tokens": 2048, "safety_tokens": 4096, "max_auto_continues": 3 },
  "context-optimize": { "max_summary_tokens": 8192, "min_summary_tokens": 1024, "provider_safety_tokens": 4096, "chars_per_token": 3, "request_overhead_tokens": 512 },
  "todo": { "max_visible_todos": 14, "max_auto_continuations": 20, "max_snapshot_todos": 40 }
}
```

The job event contract the model needs (states, what `timed_out` and `lost` mean, `options`) is in the `job-rules` prompt in `rules.md`. The rest is host behavior and is not sent to the model: only terminal states and advisory SLA misses are steered (never log lines). `timed_out` is nonterminal: the process remains alive and cancellable, and its later exit is reported. On session restore an overdue record is checked like a running one and becomes `lost` because stdio cannot be reattached. The `interactive` kind disables both the SLA warning and silence detection; a missed heartbeat for other kinds becomes `lost` and the process is auto-cancelled. Irreversible kinds stay disabled unless allowlisted.

# gc-assets config

Read by `scanner.ts` on every scan, so edits apply without a restart.

- `tick_ms`: background scan interval.
- `max_files`: per-category file budget for one scan.
- `age_days`: default staleness threshold (`/gc age <days>` overrides it for the process).
- `sweep`: `auto` (swept on confirm), `confirm` (only via `/gc sweep sessions`), `never` (counted, never deleted).
- Root tokens: `{tmp}`, `{agent}` (`~/.pi/agent`), `{home}`. A trailing `*` matches sibling names by prefix.

```json
{
  "tick_ms": 60000,
  "max_files": 50000,
  "age_days": 7,
  "categories": [
    { "id": "tool-output", "label": "tool output", "sweep": "auto", "roots": ["{tmp}/pi-context-guard"] },
    { "id": "tmp", "label": "pi temp", "sweep": "auto", "roots": ["{tmp}/pi-*"], "exclude": ["{tmp}/pi-context-guard"] },
    { "id": "sessions", "label": "sessions", "sweep": "confirm", "roots": ["{agent}/sessions"] },
    { "id": "git-cache", "label": "pkg cache", "sweep": "never", "roots": ["{agent}/git"] }
  ]
}
```

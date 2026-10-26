# touchbar-usage

Claude Code + Codex rate-limit windows on the MacBook Pro Touch Bar.

```
CC 5h 74% wk 6% ⟳29m  ·  CX mo 0% ⟳30d
```

- `CC` = Claude Code, `CX` = Codex.
- Window labels are derived from the API's own window length, not hardcoded.
  A Codex free plan reports one 30-day window (`mo`); paid plans report `5h`
  and `wk`. Labelling a monthly figure "5h" would be a wrong number, so the
  label follows the data.
- Credits (`$2.10`) appear **only** when the account actually has extra usage
  enabled — otherwise a permanent `$0.00` eats scarce strip width.
- The `⟳` figure is the soonest upcoming window reset.
- A trailing `!` means the data is older than 15 minutes (usually a sleep).

## Layout

| Path | Role |
|---|---|
| `index.ts` | pi extension — polls every 15s, `/touchbar-usage` command |
| `src/usage.mjs` | standalone core — fetch, parse, publish. No deps, no pi imports |
| `bin/pi-usagebar` | Touch Bar host entrypoint, prints one line |
| `host/main.swift` | native Control Strip app — no BTT/MTMR needed |
| `host/build.sh` | builds `~/Applications/UsageBar.app` (CLT only, no Xcode) |

Both the extension and the Touch Bar host call the same core. In Pi, the extension
mounts a persistent `aboveEditor` widget; the aggregate package's standard TUI
layout places that widget in the right-panel middle. It shows context and each
Claude/Codex window as a progress bar, plus cumulative session input/output
tokens. The native app bundles a copy of the core at build time and never talks
to pi, so **the strip keeps updating with pi closed.** Rebuild the app after
updating this extension.

## Endpoints

| Service | Endpoint | Auth |
|---|---|---|
| Claude | `GET api.anthropic.com/api/oauth/usage` | keychain `Claude Code-credentials` → `claudeAiOauth.accessToken`, plus `anthropic-beta: oauth-2025-04-20` |
| Codex | `GET chatgpt.com/backend-api/wham/usage` | pi's `~/.pi/agent/auth.json` → `openai-codex` OAuth access + account ID; falls back to `~/.codex/auth.json` only when pi has no OAuth login |

Note the Codex path is `/wham/usage`. `/backend-api/codex/usage` also exists
but serves an HTML holding page, which is why the core treats a JSON parse
failure as `shape` rather than as bad data.

Both are unofficial and have changed shape before, so each side keeps a
hardcoded primary path plus a fallback (Claude's flat `limits[]` array) and
degrades to `!shape` instead of crashing or silently showing a wrong number.

## Install

```sh
chmod +x ~/.pi/agent/extensions/touchbar-usage/bin/pi-usagebar
~/.pi/agent/extensions/touchbar-usage/bin/pi-usagebar   # should print a line
```

Enable the extension in pi, then `/touchbar-usage status`.

### UsageBar.app (native, recommended)

MTMR is Intel-only and needs Rosetta; BetterTouchTool is paid. Both are shells
around two private `DFRFoundation` calls, so `host/` makes those calls directly
— arm64 native, ~200 lines, no dependencies.

```sh
host/build.sh                                    # -> ~/Applications/UsageBar.app
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.handlerone.usagebar.plist
```

`LSUIElement`, so there is no Dock tile and no menu bar item — the Touch Bar is
the whole UI. The host automatically presents left-aligned quota progress charts
in the app-controls area, leaving the right Control Strip available. This replaces
the foreground app's Touch Bar controls while presented. No tap or expanded view
is needed. Each window shows its label, usage percentage, reset countdown, and a progress
track; orange `!` marks cached/unavailable data, and red marks usage at 90% or
higher. The adjacent **Optimize** button sends a local Unix-socket request to
Pi's most recently active session (no global shortcut, app activation, or keyboard
input). The bundled `core/guards/context-optimize.ts` extension compacts that idle Pi session
into a concise implementation-state summary. Compaction rotates across available
Claude Haiku 4.5, GPT-5.5, and local llama.cpp/MLX tiers, immediately failing over
on usage limits, broken streams, API failures, or network errors. It does nothing
if Pi is not running or the agent is working; the button briefly reports **No Pi** or **Pi busy** instead.
These are current quota gauges, not historical trend charts. Refresh is every
15 seconds and on wake. This is polling, not a real-time API stream; upstream
accounting may lag. Charts use a compact 340pt layout and a presentation mode
that reserves the right Control Strip. Close the charts with the system close
button; app, window, Space switches and wake never reopen them. Tap the Control
Strip's `π` button to reopen. Charts are presented once when the host starts.
Presentation uses private macOS APIs.
The figures are account-wide, not per-window; Codex follows pi's login even if the
standalone Codex CLI is signed into a different account.

```sh
launchctl kickstart -k gui/$(id -u)/dev.handlerone.usagebar   # restart after a rebuild
# Run /reload in each Pi session to load the new local Optimize IPC listener
launchctl bootout gui/$(id -u)/dev.handlerone.usagebar        # stop + disable
cat /tmp/usagebar.err.log                                     # only written on failure
```

If the strip stays empty: System Settings → Keyboard → Touch Bar shows must be
**App Controls with Control Strip** (or Control Strip), not "F1, F2…". The app
terminates immediately and logs `addSystemTrayItem: unavailable` if a future
macOS drops the private selector.

### BetterTouchTool

Touch Bar → `+` → **Shell Script / Task Widget**

- Script path: `~/.pi/agent/extensions/touchbar-usage/bin/pi-usagebar`
- Launch path `/bin/sh`, parameters `-c`
- Run every `60` seconds
- Uncheck "run script in background" so stdout becomes the button title

### MTMR

`~/Library/Application Support/MTMR/items.json`:

```json
{
  "type": "shellScriptTitledButton",
  "source": { "filePath": "~/.pi/agent/extensions/touchbar-usage/bin/pi-usagebar" },
  "refreshInterval": 60,
  "align": "left"
}
```

## Concurrency

Every pi session polls, but normally only one process per 15-second interval does network work:

- 15s freshness floor, checked against the published file's `updatedAt`
- atomic `mkdir` lease so exactly one process fetches
- lease reclaimed on TTL **or** dead-PID (`kill(pid, 0)`), so a tmux pane
  killed mid-fetch does not wedge the others for 90 seconds
- `rename()` publish, so the Touch Bar host never reads a torn file
- `os.homedir()` / `dscl` everywhere — `$HOME` is unreliable under a tmux
  server that outlived its shell, and absent under launchd

## Troubleshooting

```sh
bin/pi-usagebar --json     # full published state
bin/pi-usagebar --force    # bypass the 15s floor
```

Error suffixes: `!auth` (token expired — run the CLI once to refresh),
`!shape` (endpoint changed), `!offline`, `!429`, `!timeout`.
A bare `—` means no credentials found for that side.

`PI_USAGEBAR_NODE` overrides node resolution if the candidate list misses yours.

`PI_USAGEBAR_TRACE=<file>` appends one line per outbound HTTP request. This is
how the singleton property is verified rather than assumed — run N pollers,
then count the lines:

```sh
PI_USAGEBAR_TRACE=/tmp/t.log
for i in $(seq 1 12); do node src/usage.mjs --force & done; wait
wc -l /tmp/t.log   # 2, not 24
```

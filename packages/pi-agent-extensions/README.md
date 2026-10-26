# pi-agent-extensions

Global extensions for the [pi coding agent](https://github.com/earendil-works/pi)
(`@earendil-works/pi-coding-agent`). The canonical editable checkout lives at
`~/Downloads/pi-agent-extensions` and Pi loads it as a local package through
`~/.pi/agent/settings.json`. Keeping source checkouts in Downloads avoids editing
Pi's managed `~/.pi/agent/git` cache, which package updates may reset.

Not to be confused with `D:\projects\pi`, a separate CLI with its own unrelated
extension system in `exts/`.

## Extensions

| Extension | What it does |
|---|---|
| `touchbar-usage/` | Git submodule: Claude Code and Codex quota polling with Touch Bar charts and a persistent right-panel TUI showing context/quota progress bars plus session input/output tokens. See its README for native host setup. |
| `claude-cli/` | Git submodule: wraps the authenticated Claude CLI as a Pi provider while delegating tool calls and execution to Pi. Supports text and image input. |
| `odysseus-bridge/` | Git submodule: exposes the live Pi harness and all authenticated Pi models through an OpenAI-compatible endpoint for Odysseus and other chat clients. |
| `macos-browser-control/` | Git submodule: native Quartz browser automation with a tracked virtual mouse. |
| `web-ui-vision/` | Git submodule: visual browser interaction via screenshots and reusable element references. Requires `playwright-core`. |
| `cloud-admin/` | Git submodule: session-scoped Cloudflare and Tailscale administration. |
| `core/guards/context-optimize.ts` | Routes built-in `/compact`, auto-compaction, `/optimize-context`, and the Touch Bar **Optimize** action through a round-robin cheap-model pool (Claude Haiku 4.5, Codex GPT-5.6 Luna with Sol/API fallback, local llama.cpp/MLX) with failover on any provider or transport error. Also adds `Ctrl-Shift-O` and a persistent context-percentage status. |
| `core/guards/context-guard.ts` | Caps a single tool result to a share of the *active* model's context window and elides the middle, keeping head and tail. Points the model at pi's complete saved output instead of the truncated copy. |
| `core/guards/file-tool-discipline.ts` | Makes GPT models use Pi's auditable `write` tool for new/full files and `edit` for targeted changes. Strengthens the per-turn prompt and blocks obvious shell/heredoc/script-based source-file authoring while allowing normal commands, generated artifacts, logs, and temporary files. |
| `core/guards/answer-floor.ts` | Stops pi's own reply budget from silently collapsing to a handful of tokens. When a reply is cut off anyway, compacts if the budget was short and resumes it — no `/compact` by hand. |
| `usage-roundrobin.ts` | Spreads turns across available models/providers so no 5h usage window runs dry. The model picker includes **Auto Rotate**: choosing it enables managed rotation, while choosing a real model disables rotation and keeps that model fixed; either choice becomes the next startup default. With no explicit `/roundrobin models` list or scoped models, the pool includes every available model; `/roundrobin models <provider/model ...>` restricts it. Claude CLI counts against the Claude subscription window, not a pay-as-you-go budget. Reads `~/.pi/usage-touchbar.json`, charges each turn's tokens by a relative price index, projects each window forward with observed drain velocity, and picks the lowest charge-per-unit-of-predicted-headroom. In auto mode, HTTP 429 and quota-limit failures cool down the exhausted provider and retry on another compatible provider in the configured pool. Switches only once the current model has burned a quantum, so the prompt cache survives. `/roundrobin [status\|on\|off\|now\|models\|set\|reset]`. |
| `thinking-control.ts` | Adds the `/think` slash command pi lacks, and makes "off" actually reach the chat template instead of leaving thinking on at max effort. |
| `remote-control.ts` | Shares the active pi session through a token-protected mobile web UI and optional Cloudflare Quick Tunnel. Start with `/remote-control start`; stop with `/remote-control stop`. |
| `tui/` | Owns the responsive fullscreen layout and `/right-panel` collapse command: tools at the panel top, `aboveEditor` widgets in its middle, and `belowEditor` widgets plus statuses/footer at the bottom. Run `npm run install:tui` after Pi upgrades. |
| `core/` | Job supervisor (`start_job`, `job_status`, `cancel_job`, `job_logs`) with steered `job_event`s, the todo queue (`core/todo.ts`), plus the bundled guards in `core/guards/` (context-guard, answer-floor, context-optimize, file-tool-discipline). All prompts load from `rules.md`, all numeric limits from `contexts.md`, job kinds and commands from `commands.md` (three md files in total). The job tools and their rules exist only where `/bin/sh` does, so they are absent on native Windows. Dev replay, tests, and the token benchmark live in `core/dev/`. |
| `gc-assets/` | Right-panel heap/RSS bars plus a background scan of pi-owned assets (tool-output temp, pi temp, sessions, package cache) with stale-byte counts. `/gc [status\|scan\|heap\|sweep [sessions]\|age <days>\|hide\|show]`: `heap` forces V8 GC; `sweep` deletes files older than the age (default 7d) after confirmation, and only touches sessions when named explicitly. |
| `core/todo.ts` | Persistent human-ordered todo queue in the right panel. The agent adds discovered work through the `todo` tool and auto-continues with the next open item. Use `/todo` or Ctrl-Shift-T to reorder/status/delete interactively; `/todo add <text>`, `/todo move <id> <position>`, and `/todo auto on\|off` work directly. |

The context-control single-file extensions exist because of one shared root cause: pi's
context accounting assumes a large hosted model, and every default it picks is
wrong in a way that fails *silently* against a local llama.cpp server.

`core/guards/context-optimize.ts` intercepts `session_before_compact`, so it covers the real
built-in `/compact` command and automatic/overflow compaction rather than merely
adding an alias. Each run starts at the next available tier—Claude Haiku 4.5,
Codex GPT-5.6 Luna (GPT-6.1 Sol if Luna is unavailable, or API GPT-5.5 if neither is available), then a local provider whose id starts with `llamacpp`, `mlx`, `ollama`,
`lmstudio`, or `local`. Missing tiers are skipped. Empty, truncated, usage-limit,
API, network, and broken-stream failures rotate immediately to the next tier;
if every cheap tier fails, compaction is cancelled instead of silently billing
the active high-cost conversation model. The active conversation model is never
changed. Compaction uses an eight-word system prompt and computes request
headroom per candidate before calling it:

```text
summary output = min(8192, model.maxTokens,
                     contextWindow - estimatedInput - 4096)
```

Input is conservatively estimated at three characters per token plus 512 tokens
of provider-wrapper overhead. Candidates with less than 1024 output tokens left
are rotated out instead of truncating the transcript and creating a lossy
checkpoint. This lets a small Apple Silicon local model participate whenever the
whole compaction request actually fits its window.

### The arithmetic they defend

pi sizes every request in `ai/src/api/simple-options.ts`:

```js
CONTEXT_SAFETY_TOKENS = 4096, MIN_MAX_TOKENS = 1
available  = model.contextWindow - estimateContextTokens(context) - 4096
max_tokens = min(model.maxTokens, max(1, available))
```

Two constants do the damage. The 4096-token safety margin is deducted from the
*answer*, so on a small window it eats the reply rather than the prompt. And the
floor is **1**, not `MIN_ANSWER_TOKENS` (1024), so when the budget collapses pi
does not error — it asks for whatever is left and returns a sentence that stops
mid-word.

Observed, in session `01a0559f` on an 8192-token window:

```
8192 (window) − 4024 (context) − 4096 (safety) = 72 → max_tokens: 72
"stopReason": "length", "output": 72
```

The reply ended at "I'm going to create a".

### The rule that keeps it from happening

```
compaction.reserveTokens  ≥  4096 + model.maxTokens
```

Compaction triggers at `contextWindow − reserveTokens`, so the reserve has to
cover the hidden safety margin *plus* a full reply. Anything less and compaction
fires only after the budget has already collapsed. `core/guards/answer-floor.ts` is the
backstop for when that rule drifts — a new model, a hand-edited setting.

## Token and cache discipline (core)

Everything `core/` puts in front of the model is resent with every request, so it is kept small and kept
append-only:

- **System prompt additions are static.** `job-rules` and `todo-rules` (`rules.md`) are appended after the base
  prompt, only while the tool they explain is active, and never contain the queue, a clock, or a counter. A byte that
  changes early in a request invalidates every cached token after it.
- **State goes at the end of the history, and only when it changed.** The todo queue is injected as a short
  `<todo_queue>` message when the human changed it since the model last saw it (after a resume, `/tree`, or compaction
  it is shown once more). The model's own `todo` calls never trigger a snapshot; their results are compact
  (`Started #3 (2 open)`) and only `list` returns the whole queue. Before this, the full workflow text and queue were
  persisted into the history on every prompt, empty queue included.
- **No tools that cannot run.** `start_job` and its three companions are not registered without `/bin/sh`.

Measure a change with the fake-host benchmark (no model calls). It replays one scripted 8-prompt session through
`core/index.ts`, rebuilds each request, and reports tokens (chars/4) plus how much of the previous request stays a
valid cache prefix:

```sh
export PI_PACKAGE_DIR=<path to @earendil-works/pi-coding-agent>   # default: Homebrew layout
git archive HEAD core | tar -x -C /tmp/before                      # a reference to compare against
node core/dev/token-bench.mjs --against /tmp/before/core          # add --posix on native Windows
node core/dev/test-core.mjs && node core/dev/test-todo.mjs
```

On the scripted session, against the previous revision: 48 requests, system additions 516 -> 266 tokens and tool
schemas 410 -> 341 per request, persisted core messages 2.3k -> 0.2k tokens, total input -9.8% (-12.9% on a host
without `/bin/sh`), and no cache-prefix break in either version. The session's tool output, which core does not touch,
is held constant, so the percentage depends on how much of a real session is tool output.

## Remote control

Run `/remote-control start` to create a temporary HTTPS pairing link through
`cloudflared`, or `/remote-control local` for a loopback-only link. The built-in browser UI can view the conversation, stream replies, send or
steer prompts, and abort the current operation. On page reload it restores the
authenticated session from its secure cookie, renders an immediate `/api/state`
snapshot, and then attaches `/api/events` SSE for live updates.

The same server exposes an OpenAI-compatible facade for a richer existing UI:

```text
Base URL: https://<tunnel-host>/v1
API key:  <the token after # in the pairing URL>
Model:    pi-session
```

It implements `GET /v1/models` and streaming or non-streaming
`POST /v1/chat/completions`. Streaming uses standard OpenAI SSE chunks, disables
proxy buffering, and sends heartbeat comments during long tool calls. The
facade deliberately forwards only the latest
user message because pi remains the canonical owner of conversation history,
tools, and execution state. It works with Open WebUI and clients that permit a
custom OpenAI endpoint, including Conduit on iOS and Android. Official ChatGPT
and Claude mobile apps do not permit arbitrary compatible endpoints.

The URL fragment contains a bearer-strength pairing secret. Anyone with the
complete link can control pi and all tools available to the session, so keep it
private and run `/remote-control stop` when finished.

### Conduit mobile setup

1. Install [Conduit](https://github.com/cogwheel0/conduit).
2. Choose **Direct connection** and **OpenAI-compatible**.
3. Enter the base URL, API key, and `pi-session` model shown by pi.
4. Start a chat. Pi's active local session remains authoritative even though
   Conduit also keeps a device-local transcript.

Open WebUI can use the same values as an OpenAI-compatible connection.

## Installation

Keep the editable aggregate checkout in Downloads and install it by local path:

```sh
git clone --recurse-submodules https://github.com/TuanKietTran/pi-agent-extensions ~/Downloads/pi-agent-extensions
pi install ~/Downloads/pi-agent-extensions
cd ~/Downloads/pi-agent-extensions && npm run install:tui
```

The active user settings entry is equivalent to:

```json
{ "packages": ["../../Downloads/pi-agent-extensions"] }
```

Relative local package paths in `~/.pi/agent/settings.json` resolve from
`~/.pi/agent`. The package manifest loads the extensions in this repository and
its submodules without copying them into Pi's managed cache. After a non-recursive
clone, initialize the submodules with:

```sh
cd ~/Downloads/pi-agent-extensions
git submodule update --init --recursive
```

## Layout

Each extension is either a single `.ts` file or a directory with `index.ts`.
pi loads them from trusted locations only:

| Path | Scope |
|---|---|
| `~/.pi/agent/extensions/*.ts` | global |
| `~/.pi/agent/extensions/*/index.ts` | global |
| `.pi/extensions/*.ts` | project-local, after the project is trusted |

## Working on these

Extension entry points use the declaration-first structure documented in [`core/DESIGN.md`](core/DESIGN.md): shared Pi event constants, top-level command/tool metadata, Markdown-owned model policy, and registry-owned right-panel tabs. `npm test` guards against embedding lifecycle and command names directly in registrations; `npm run check` type-checks the aggregate checkout.

Extensions in auto-discovered locations hot-reload with `/reload` inside pi. Use
`pi -e ./path.ts` only for one-off tests — it bypasses discovery and cannot be
reloaded.

Types come from the `@earendil-works/pi-coding-agent` package that ships inside
the pi install; there is no build step and no `node_modules` here. pi transpiles
the TypeScript itself.

## Not collected here

`D:\projects\pwb\pi\pwb-tools.ts` is a pi extension too, but it is owned by the
pwb project, loaded by absolute path from `settings.json`, and versioned with the
tool it bridges. It stays where it is.

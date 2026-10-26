# Distributed session chat

A focused TypeScript application for a **celld fleet**, with one SQLite Durable Object per room and external Pi / Claude Code processes. The browser sends to one selected agent; agent output never creates another job. The authorized local **two-node OrbStack/celld fleet is running on ports 18877 / 18878** and passed shared-history, streaming, continuity and cancellation checks with two explicitly mock agents. The parent separately verified **real Pi and Claude workers across both celld ingress nodes**, including incremental output and resumed recall for both agents. See [BUILD-REPORT.md](BUILD-REPORT.md) and the parent-owned [VERIFICATION.md](VERIFICATION.md) for evidence and limits.

## Current interface and live chat

The temporary UI/UX follows the visual structure of `claude.ai/code`: dark sidebar, recent sessions, a quiet conversation canvas and bottom composer. It is this project's own interface, not an official Claude application. Pi and Claude remain separate selectable targets. Enter sends; Shift+Enter adds a newline. Stop cancels the selected turn. Recent **room names only** are stored locally; tokens and transcripts are not.

Open <http://127.0.0.1:18877/> (or node B on port 18878), connect to room `demo`, and enter `CHAT_TOKEN` from the ignored local `.env`. Never paste the token into a URL or commit it. Standby real workers can be started explicitly:

```sh
CONFIRM_LIVE_WORKERS=YES node --env-file=.env --import tsx scripts/live-workers.ts
```

This launcher serves Pi on A and Claude on B, uses persistent `.agent-data/live`, and **disables coding tools** for chat-only operation. Provider authentication stays on this machine; messages incur normal provider usage. Stop this launcher before starting another copy with the same worker identities. The currently started launcher is a local process, not an installed login service. New UI rooms do not provision agent workers: use matching `ROOM` worker configuration, with separate persistent provider storage.

Explicit live checks (not part of `npm test`):

```sh
CONFIRM_LIVE_AGENTS=YES node --import tsx scripts/live-adapters.ts
CONFIRM_LIVE_FLEET=YES node --env-file=.env --import tsx scripts/live-fleet.ts
CONFIRM_BROWSER_LIVE=YES node --env-file=.env test/ui.browser.mjs
```

The browser check uses installed Brave on macOS by default (`BROWSER_BINARY` overrides its executable). It authenticates, sends a real turn to each standby agent in `demo`, verifies mobile layout/token isolation, and saves ignored screenshots under `.deploy/screenshots`.

## Local runtime + explicit mock agents

Requirements: Node 22+, npm. Dependencies are exact-version pinned with a lockfile.

```sh
npm ci
npm run build
npm test
```

Create an ignored `.dev.vars` at the project root with **three distinct, random secrets**, at least 24 characters each:

```dotenv
CHAT_TOKEN=<user-secret>
PI_TOKEN=<pi-worker-secret>
CLAUDE_TOKEN=<claude-worker-secret>
```

Set mode 0600 on secret files. Do not put credentials in URLs, CLI arguments, shell tracing, screenshots or logs. `npm run dev -- --port 18879` starts Wrangler/workerd on loopback, not celld. Avoid port 8787 on this host: it is occupied by the Pi bridge. The Compose fleet instead uses ports **18877 / 18878**. Open its printed URL; enter the room and `CHAT_TOKEN` into the UI. The token stays in browser memory only, not localStorage or a query string.

In two terminals, export the corresponding `AGENT_TOKEN` securely, then run:

```sh
CHAT_URL=http://127.0.0.1:18879 AGENT_MODE=mock AGENT_ID=pi WORKER_ID=pi-local ROOM=demo npm run worker
CHAT_URL=http://127.0.0.1:18879 AGENT_MODE=mock AGENT_ID=claude WORKER_ID=claude-local ROOM=demo npm run worker
```

Each command needs a different `AGENT_TOKEN`: `PI_TOKEN` or `CLAUDE_TOKEN` respectively. Set `CHAT_URL` explicitly: use port 18879 for the development command above, or 18877 / 18878 for the Compose fleet. The CLI defaults to the fleet's port 18877; do not use the Pi bridge's port 8787. **MOCK mode is synthetic, never calls an LLM, and is labeled in the startup message, saved run and transcript.** The default mode is deliberately unset, so forgetting it fails instead of silently simulating an agent.

## Actual external agents

Authenticate each installed agent independently on its worker machine, using that CLI's normal provider environment/auth storage. Tested protocol reference versions: **Pi 0.84.4**, **Claude Code 2.1.305** (`claude --help` inspected). These binaries are not installed by this project. The parent independently verified both real providers' new-session output and resumed recall using `scripts/live-adapters.ts`, then completed four real-provider turns through the actual two-node fleet using `scripts/live-fleet.ts`; see [VERIFICATION.md](VERIFICATION.md). Coding tools were disabled. This is not evidence of live tool use, live cancellation, failover or provider-session migration.

```sh
AGENT_MODE=pi AGENT_ID=pi WORKER_ID=pi-node-a ROOM=demo \
  AGENT_CWD=/path/to/trusted/workspace AGENT_DATA_DIR=/path/to/persistent/pi-sessions npm run worker

AGENT_MODE=claude AGENT_ID=claude WORKER_ID=claude-node-b ROOM=demo \
  AGENT_CWD=/path/to/trusted/workspace npm run worker
```

Export the matching `AGENT_TOKEN` and, for remote servers, `CHAT_URL=https://your-chat-origin` first. Non-loopback plain HTTP is refused by the CLI. `AGENT_BINARY` overrides the executable; `AGENT_ARGS` is a JSON array of **non-secret** optional flags (e.g. Pi provider/model). Do not override protocol/session flags. Agent cwd is intentionally explicit: tools execute there with that machine's permissions. This is a trusted-operator tool, not a multi-tenant sandbox. Pi uses its normal coding tools; Claude uses `dontAsk` (tools requiring an approval are denied, not silently auto-approved). No interactive permission relay or tool transcript UI is implemented. Pi extension dialogs are cancelled; discovered Pi extensions/skills/prompt templates are disabled.

Pi runs `pi --mode rpc --session-id UUID --session-dir DIR`, asks `get_state`, sends a JSONL `prompt`, and waits through retries until **`agent_settled`**, not `agent_end`. Claude runs `claude --print --verbose --output-format stream-json --include-partial-messages --permission-mode dontAsk`, sends the prompt over stdin, and uses `--session-id UUID` initially / `--resume UUID` subsequently. Text deltas stream as they arrive. Completion/error/exit/deadline and cancellation are handled separately. Stderr is drained but never forwarded. Raw provider errors are replaced with generic errors to avoid leaking environment values.

### Continuity and failure semantics

- SQLite stores messages, partial output, statuses, ordered events and per-agent session UUID / mode / worker identity / initialized state.
- **Provider session files remain on the external worker.** Keep Pi's `AGENT_DATA_DIR` and Claude's home/session directory persistent, and retain the same `WORKER_ID`, cwd and account. Server restart preserves metadata; worker restart resumes the provider session. Full provider context is not reconstructed from plain chat text and is not migrated across workers.
- A room/agent is pinned to its first claiming worker and mode. A different identity/mode receives 409; no silent new session. To test another mode use a new room. There is no automatic reassignment/reset endpoint.
- At most one queued/running turn per agent per room; Pi and Claude can run concurrently. A worker serves **one configured room**; run separate identities/processes/data directories for additional rooms. Do not run two copies of the same identity against the same session files.
- A claim receives a 15-second lease, renewed every 2 seconds. Lost connectivity aborts local execution. A crashed/stalled worker becomes an error when the next room request observes the expired lease. **No automatic replay of execution**, because coding tools can have side effects. Claim-response loss may similarly leave an errored turn rather than risk duplicate execution.
- Send IDs and sequenced updates are idempotent across HTTP retries. Cancel marks the run terminal immediately; the worker notices within its next heartbeat (plus request timeout), terminates the process group, then escalates to SIGKILL after 1.5 seconds. Already executed tool side effects cannot be undone; avoid starting another turn until cancellation has reached the worker.
- Browser reconnect loads the last 100 runs and continues from a durable event cursor. The event API can replay the complete history in 500-record pages. The minimal UI displays text, state and errors, not tool output/thinking. Default per-turn execution deadline: 10 minutes. Prompt limit: 12K characters; output limit: 1M characters. History/events are not pruned; there is no quota/rate-limit or user management layer.

## HTTP API

Every API request requires `Authorization: Bearer ...`. Never use tokens in query parameters. No CORS is enabled. Room IDs and worker IDs are `[A-Za-z0-9_-]{1,64}`. JSON request bodies only.

| Route under `/api/rooms/:room/` | Auth | Contract |
| --- | --- | --- |
| `GET history` | CHAT_TOKEN | `{runs, cursor}`; most recent 100 runs, chronological |
| `GET events?after=N` | CHAT_TOKEN | `{events}`; ascending cursor, up to 500; repeat with last cursor |
| `POST send` | CHAT_TOKEN | `{id, agent:"pi"\|"claude", prompt}`; 201 or idempotent 200, busy 409 |
| `POST cancel` | CHAT_TOKEN | `{id}`; terminal run snapshot |
| `POST agent/:agent/claim` | agent token | `{worker, mode:"pi"\|"claude"\|"mock"}` → `{task:null\|Run+resume}` |
| `POST agent/:agent/heartbeat` | agent token | `{worker,id}` → `{cancel:boolean}` |
| `POST agent/:agent/update` | agent token | `{worker,id,seq,update}`; sequence starts at 1 |

Updates: `{kind:"session"}`, `{kind:"delta",text}`, `{kind:"done"}`, or `{kind:"error",error}`. A worker can update only its claimed agent's run; it cannot send a user message. The mock mode is allowed only when explicitly claimed. Events contain `cursor,run_id,kind,data` (JSON-encoded data); `state` events are snapshots and `delta` events append text. Snapshot + cursor are read in the same SQLite transaction. API errors do not expose internal exceptions.

## Two-node infrastructure

[infra/README.md](infra/README.md) documents the **locally verified** OrbStack/Docker Compose fleet with two real celld v0.6.2 Linux nodes, separate persistent volumes and one internal-only MinIO bucket. MinIO/mc are built from pinned upstream source releases because their registry pulls were denied. Only Worker ports **18877 / 18878** are published on loopback; 8787 is left to the existing Pi bridge. The separately opt-in **two-exe.dev-VM** runbook is not deployment evidence. Nothing provisions or deploys during `npm ci`, build or tests. The parent handles git/push; the infra implementation does not invoke git, cosign or any publication action.

## Tests

Node's test runner executes TypeScript through tsx. Miniflare runs actual workerd + SQLite Durable Objects (not in-memory class fakes). Tests cover auth/scope/isolation, concurrent claim fencing, update replay/order, restart durability, stale leases, two executable mock worker processes, incremental output, explicit targeting/no ping-pong, session metadata continuity, cancellation and subprocess protocol fixtures. Fixtures are labeled synthetic and test adapters without LLM credentials. These automated runtime tests do **not** prove celld peer routing, object-store durability or VM failover. Separately, the authorized `scripts/verify-fleet.ts` run passed against actual celld nodes on both ingress ports, and read-only celld diagnostics verified two live compatible peers. Neither check demonstrates hard-failure takeover or production storage qualification.

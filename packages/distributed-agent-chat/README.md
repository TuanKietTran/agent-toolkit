# Distributed Agent Chat

A self-hostable chat coordinator for sending a user-authored turn to an explicitly selected coding-agent worker. It is not a managed multi-tenant service. The coordinator stores room history; provider authentication and execution remain on worker machines.

## Status and evidence

| Capability | Verified status / boundary |
|---|---|
| Standalone loopback Miniflare coordinator and arbitrary target IDs | Implemented; synthetic E2E launches two independent CLI worker processes with `AGENT_ID=nodeA/nodeB`, `AGENT_MODE=mock`, separate tokens, streams/history/reconnect, session continuity and cancellation. See `test/standalone.test.ts`. |
| Pi, Claude Code, Codex and OpenCode adapters | Adapter protocol fixtures exercise each harness's implemented output handling, completion, errors, cancellation and native-session resume. Codex `exec --json` is consumed as completed `item.completed` `agent_message` text, then chunked by the adapter into API-safe display deltas; this is not token-level streaming. No app-server delta events are accepted. Fixture behavior is not live provider evidence. |
| Native session through mock workers | Mock verifies room session continuity; it does not create a provider-native session ID. |
| Ollama | Provider/model option for compatible agent CLIs, not itself a chat worker. Examples below configure a CLI only; no Ollama install, server start, model pull, or provider request is performed. |
| Hosted VM isolation, browser IDE, GitHub OAuth/PR automation, file transfer, approval relay, billing/quotas, provider session migration | Not provided. |
| Physical multi-host operation, HA/failover, cloud-feature parity, production readiness | Not verified; no production-readiness claim. Synthetic fixtures only; no live-provider verification. The local setup is one coordinator. |

Build and test evidence, including any current failures and limitations, is recorded in [docs/IMPLEMENTATION-REPORT.md](docs/IMPLEMENTATION-REPORT.md). No deployment or provider usage is implied.

## Local standalone setup

Requirements: Node.js 22 or newer and npm. Synthetic tests need no provider CLI, account, or model. From this package directory:

```sh
npm ci
npm run setup
npm run build
npm run doctor
npm start
```

`npm run setup` creates `.env` exclusively (it refuses to overwrite an existing file), generates distinct high-entropy `CHAT_TOKEN` and `AGENT_TOKENS` secrets, and does not print them. `npm run doctor` is a coordinator-only check: it requires Node.js 22+, validates `.env` secrets, and checks that `dist/worker.js` exists. It does not launch or validate a worker executable, Codex shim, or provider. For Windows worker startup, `AGENT_BINARY` must be an absolute path to a native `.exe` (not `.cmd`/`.ps1`; mock is exempt). `npm run worker` validates worker configuration and starts polling but does not prove reachability or health at startup. To establish worker health, run it with the complete exported environment on the worker host and verify that it stays connected and completes a synthetic MOCK turn end-to-end. Optional `AGENT_DOCTOR=1` runs the configured executable with `--version` only; it is not a provider check or health probe. See [worker configuration](docs/network-and-security.md). `npm start` builds and then explicitly loads `.env` using Node's `--env-file`; `scripts/server.ts` itself does not load dotenv. QA did not invoke `npm start`: it starts the persistent coordinator, which you should start when ready. The coordinator binds to `127.0.0.1` by default and persists local data under `.data/miniflare`. Keep `.env` private and never expose loopback development directly to the internet.

`AGENT_TOKENS` maps target IDs to distinct tokens. Setup generates `pi`, `claude`, `codex`, `opencode`, and `ollama`; these labels do not represent automatically running workers. Provision each worker separately with only its matching `AGENT_TOKEN` and required provider settings. Never load the coordinator `.env` into a worker or provide it `CHAT_TOKEN` or the `AGENT_TOKENS` map. Tokens must be distinct and at least 24 characters. The synthetic E2E verifies API token scope, not secret isolation between worker processes.

With each worker's settings securely provisioned/exported, launch it (no provider call in mock mode):

```sh
npm run worker
```

For example, use `AGENT_ID=pi`, `WORKER_ID=pi-host`, `ROOM=demo`, `AGENT_MODE=mock`, `CHAT_URL=http://127.0.0.1:18877`, and the token mapped to `pi`. To use `nodeA`/`nodeB`, first configure those IDs and distinct tokens in the coordinator mapping. `AGENT_MODE` selects adapter/runtime behavior independently of the target ID. Supported modes include `mock`, `pi`, `claude`, `codex`, and `opencode`; real modes execute their respective local CLI and may use provider credentials. On Windows, configure `AGENT_BINARY` to an absolute path to a native `.exe` (not a `.cmd`/`.ps1` package-manager shim; mock mode is exempt). Live Codex runtime is unverified until the adapter worker validates prompt delivery on stdin and fidelity to official events; live OpenCode runtime is unverified until terminal behavior and process exit are validated. Use `mock` for no-provider smoke testing.

### Provider and model options

Use a real mode only when the corresponding CLI and credentials are already configured. `AGENT_PROVIDER` and `AGENT_MODEL` are shared options; Pi-specific safety options include `AGENT_PI_NO_TOOLS=1`, `AGENT_PI_TOOLS=...`, and `AGENT_PI_TRUSTED_NATIVE=1` (native Pi features are explicit opt-in). The CLI manages protocol/session/permission arguments; do not put flags in `AGENT_ARGS`.

Ollama examples below document configuration only; they do not launch a worker, install software, start Ollama, pull a model, or make a provider request. Ollama is a provider, not an `AGENT_MODE` or worker type. The adapter maps provider/model options per harness: Pi passes provider/model flags; Codex uses its Ollama local-provider arguments when selected; OpenCode uses a provider/model namespace; Claude accepts only absent provider or case-sensitive `ollama` when `ANTHROPIC_BASE_URL` is configured (with its compatible auth environment). Mock ignores provider/model. For Pi, Codex, and OpenCode, selecting `ollama` does not inject an Ollama endpoint or special credentials; any needed endpoint must be configured in the ordinary environment. These mappings are implementation behavior, not evidence of live compatibility.

```sh
# Claude Code / Ollama configuration for a worker environment
AGENT_ID=claude
AGENT_MODE=claude
AGENT_PROVIDER=ollama
AGENT_MODEL=qwen2.5-coder:7b
ANTHROPIC_BASE_URL=http://localhost:11434
ANTHROPIC_AUTH_TOKEN=ollama
ANTHROPIC_API_KEY=""

# Pi provider/model configuration for a worker environment
AGENT_ID=pi
AGENT_MODE=pi
AGENT_PROVIDER=ollama
AGENT_MODEL=qwen2.5-coder:7b
AGENT_PI_NO_TOOLS=1
```

These are illustrative environment settings only; they were not executed and do not install/start Ollama, acquire a model, or make a provider request. `AGENT_PROVIDER=ollama` is supported by the adapter mapping as described above, but live CLI/provider behavior is unverified. Provider/model naming varies by harness; consult the [Ollama Claude Code](https://docs.ollama.com/integrations/claude-code) and [Ollama Pi](https://docs.ollama.com/integrations/pi) integration docs. Never send bearer tokens over non-loopback plain HTTP. For remote workers use HTTPS or an SSH tunnel; see [network and secure setup](docs/network-and-security.md).

## Deployment boundary

The coordinator is a single authority for a room unless you deliberately configure supported Durable Object infrastructure. Historical celld/OrbStack notes in [infra/README.md](infra/README.md) are not a portable default or evidence of a currently running fleet. No hosted service, cloud-feature parity, cross-region failover, or production readiness is implied. Synthetic fixtures only; no live-provider or physical multi-host verification. The six-high-advisory dependency issue remains a public-deployment blocker; see [dependency audit](docs/DEPENDENCY-AUDIT.md).

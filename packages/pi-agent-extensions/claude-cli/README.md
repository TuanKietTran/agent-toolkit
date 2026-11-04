# Claude CLI provider

A [pi](https://github.com/earendil-works/pi) provider extension that wraps the local `claude` CLI binary. Auth is handled by whatever `claude` is already logged into — no separate API key or OAuth setup required.

## Requirements

- [pi](https://github.com/earendil-works/pi) coding agent
- [Claude CLI](https://claude.ai/download) installed and authenticated

```sh
claude auth login
```

## Install

```sh
pi install path/to/pi-agent-extensions
```

## Usage

```sh
pi --provider claude-cli "your prompt"
pi --provider claude-cli --model claude-opus-5 "your prompt"
```

Available models: `claude-fable-5`, `claude-opus-5-5`, `claude-opus-5`, `claude-opus-4-8`, `claude-sonnet-5-5`, `claude-sonnet-5`, `claude-sonnet-4-6`, `claude-haiku-5-5`, `claude-haiku-4-5-20251001`

## How it works

Select the `claude-cli` provider entry from the `pi-agent-extensions` package. The extension spawns `claude -p <prompt> --output-format stream-json` as a subprocess and pipes its response into Pi.

Pi remains responsible for tools:

- Claude's native tools, plugins, hooks, and MCP servers are disabled for the subprocess.
- Permission prompts are disabled at the Claude subprocess boundary (`dontAsk` / no prompt host), so allow/deny requests cannot leak into Pi.
- The currently active Pi tools and their schemas are supplied through an authenticated, capture-only loopback MCP bridge, with structured output as a fallback.
- The MCP bridge records requests but never executes tool implementations; requested calls are emitted as real Pi `ToolCall` blocks.
- Pi validates and executes each call, emits the normal tool lifecycle events, and returns the result on the next turn.
- The loopback server uses an ephemeral port and per-turn bearer token, then removes its temporary config when the turn ends.
- Pi only needs Claude's first message when it requests tools, so the `claude` process is stopped as soon as every requested call is captured. This is one API request per tool call instead of three.

This means Pi options such as `--tools write` and `--exclude-tools bash` are respected by the `claude-cli` provider. A recent Claude CLI with `--json-schema`, `--setting-sources`, and streamable HTTP MCP support is required.

## Token use

Each Pi turn spawns a fresh `claude -p`. The prompt is built to keep that cheap: Claude Code's default system prompt is replaced by a short stub, the conversation travels as one block per message in the user turn (so Pi's own prompt stays byte-identical and cached), tool schemas are sent once through the MCP list, and tool call ids are shortened. On the repeatable ten-step scenario this cut tokens per run from about 200k to 52k (Haiku, four tools) and from 342k to 110k with eighteen tools. Method, numbers, ablations and what did not help: [docs/TOKEN-DIET.md](docs/TOKEN-DIET.md). Measure your own setup with `node claude-cli/scripts/measure-tokens.mjs`.

Environment variables: `PI_CLAUDE_CLI_USAGE_LOG=<file>` appends one JSON line of usage per spawned process; `PI_CLAUDE_CLI_ADVISOR=<model>` passes `--advisor <model>` to `claude` (off by default: it adds about 1.6k input tokens to every request).

## Response behavior

The provider appends direct, concise response rules after conversation history and reinforces them in the structured `text` field. Routine tool requests should use empty text. Replies omit conversational filler and unsolicited suggestions; requested detail, blockers, verification, and required confirmations remain intact. The shared `core` extension applies the same defaults to all models through `core/rules.md`.

This is prompt guidance, not a hard character/token cap or text filter. Reload Pi after provider code changes; core response-rule wording is re-read each run once its loader is active.

## License

MIT

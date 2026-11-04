# opencode-cli provider for pi

A [pi](https://github.com/earendil-works/pi) provider extension that wraps the local `opencode` CLI, the sibling of [`claude-cli`](../claude-cli). Auth and model access come from whatever OpenCode already has: the free OpenCode Zen models work out of the box, and any provider connected with `opencode auth login` shows up too.

## Requirements

- [pi](https://github.com/earendil-works/pi) coding agent
- [OpenCode](https://opencode.ai) 2.x on `PATH` (`brew install opencode`)

## Install

```sh
pi install path/to/pi-agent-extensions
```

## Usage

```sh
pi --provider opencode-cli --model opencode/glm-5.3-flash-free "your prompt"
pi --list-models opencode
```

Model ids are OpenCode's own `provider/model` ids. The list comes from `opencode models` when pi starts (about 0.5 s) and falls back to a short static list if OpenCode is missing.

| Variable | Effect |
| --- | --- |
| `OPENCODE_BIN` | Path to the `opencode` binary (otherwise `~/.opencode/bin`, Homebrew, `/usr/local/bin`, `~/.local/bin`, `PATH`) |
| `PI_OPENCODE_MODELS` | Comma-separated model ids; skips discovery |
| `PI_OPENCODE_READ` | `deny` removes OpenCode's native `read` tool entirely; default `ask` keeps it listed but non-interactive runs auto-reject it |

## How it works

Each turn spawns `opencode run --standalone --format json --agent pi-bridge --model <id>`:

- The run uses a private server (`--standalone`) so the per-run config applies. The shared background service would ignore it.
- The config is injected through `OPENCODE_CONFIG_CONTENT`. It defines a `pi-bridge` agent whose permissions deny every native tool (bash, edit, write, glob, grep, web, subagent, ...) and a remote MCP server for the turn.
- Pi's system prompt, the conversation so far, the tool-bridge instructions and the current message go in on **stdin**. `opencode run` treats a piped stdin as the message and waits for it to close.
- Pi's active tools are exposed through a capture-only loopback MCP server (ephemeral port, per-turn bearer token). OpenCode 2.x reaches MCP tools through its `execute` tool as `tools["pi-host"].<name>(...)`. The handler records the request and never executes it.
- When the step that issued the calls finishes, the process is stopped, duplicate calls are dropped, and the calls become real Pi `ToolCall` blocks. Pi validates and runs them and returns the result on the next turn.
- Fallback for models that do not reach the bridge: a `<pi_tool_calls>[{"name":...,"arguments":{...}}]</pi_tool_calls>` block in the reply is parsed (active tool names only).
- Image blocks on the current message are written to temp files and passed with `--file`.
- The OpenCode session each run creates is deleted afterwards, because Pi owns the history.

## Limits

- **Free-tier quota.** Zen free models share a small quota. When it runs out OpenCode emits `provider.free-limit` with a multi-hour `retryAfterMs`; the provider surfaces that as the error message. Connect a provider with `opencode auth login` for sustained use.
- **No token streaming.** `opencode run --format json` emits whole text parts, so text appears per step rather than per token.
- **No Claude-style `/memory` command.** OpenCode has no equivalent file.
- Model metadata (context window, output cap, cost) is not exposed by `opencode models` in 2.x, so every model reports 128K / 32K / free. Image input is guessed from the id.
- The tests cover event parsing, permissions, tool-call extraction and dedupe, and the provider loop against a fake `opencode`. Tool-calling through a real model has not been exercised here; do that before relying on it.

## License

MIT

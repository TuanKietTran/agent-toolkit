# pi-agent-extensions

A collection of tools for working with coding agents (Pi, Claude Code, Codex). See each package family and the root skill collection for details.

| Package | What it is |
|---|---|
| [`packages/system-one`](packages/system-one) | Local-first model-pick decision model (never permission decisions) |
| [`packages/distributed-agent-chat`](packages/distributed-agent-chat) | Distributed Pi and Claude Code session chat on a two-node fleet |
| [`skills/`](skills/) | Agent-neutral skill collection and shared installer |
| [`packages/agent-cli-lab`](packages/agent-cli-lab) | Harness that hosts interactive agent CLIs in PTYs (`labctl`, lab-commander skill) |
| [`packages/pi-agent-extensions`](packages/pi-agent-extensions) | Pi extension package with core, TUI, usage, browser-control, and Claude CLI feature families |

See [CONTRIBUTING.md](CONTRIBUTING.md) for the package-family workflow (`node tools/pkg.mjs ci <package>`).

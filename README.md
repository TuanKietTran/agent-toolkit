# agent-toolkit

A collection of tools for working with coding agents (Pi, Claude Code, Codex). See each package family and the root skill collection for details.

Note: `packages/h1` is the renamed PTY harness — see the migration table in [`packages/h1/README.md`](packages/h1/README.md#migration) for the new binary name, environment variables, and data directory.

| Package | What it is |
|---|---|
| [`packages/system-one`](packages/system-one) | Local-first model-pick decision model (never permission decisions) |
| [`packages/distributed-agent-chat`](packages/distributed-agent-chat) | Distributed Pi and Claude Code session chat on a two-node fleet |
| [`skills/`](skills/) | Agent-neutral skill collection and shared installer |
| [`packages/h1`](packages/h1) | Harness that hosts interactive agent CLIs in PTYs (`labctl`, lab-commander skill) |
| [`packages/pi-agent-extensions`](packages/pi-agent-extensions) | Pi extension package with core, TUI, usage, browser-control, and Claude CLI feature families |

See [CONTRIBUTING.md](CONTRIBUTING.md) for the package-family workflow (`node tools/pkg.mjs ci <package>`).

Licensed under the MIT License — see [LICENSE](LICENSE).

Graphspec overlay: the console overlays each lab with its graphspec resolution — the planned manifest nodes and edges, the resolved model and pick tag (via, rule, and reason from system-one), team, run, harness, and requested model — in the graph, table, and describe views, so what was planned and why that model was picked is visible alongside the live lab state without opening the manifest or trace files separately.

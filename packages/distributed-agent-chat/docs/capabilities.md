# Capability boundaries

This project routes explicit user turns to external CLI workers and renders a normalized conversation. It is not a hosted coding agent. The table distinguishes what this application controls from behavior delegated to the installed harness/provider. Check the adapter implementation in the exact checkout before relying on a provider-specific behavior.

| Area | This application | Harness/provider-owned or unavailable |
|---|---|---|
| Turn routing | User selects a configured agent; agent output does not implicitly dispatch another agent | Harness-specific orchestration and handoffs |
| Identity and credentials | Worker authentication at the chat API | Provider login, API keys, account entitlements and model access |
| Model selection | Only where the current adapter explicitly accepts and applies configuration | Provider model availability, billing and model policy |
| Tools and permissions | No universal permission or approval relay | Native filesystem/shell tools, sandboxing, MCP, extension tools and confirmation UX |
| Context/session | Chat transcript and whatever session metadata the adapter persists | Full native context, provider-side compaction, account history, portability between hosts |
| Results | Normalized text/status and explicitly implemented activity names/status; numeric fields only where a documented, reported event provides them | Rich artifacts, IDE state, diffs, screenshots, complete tool transcript, and per-harness metrics where no documented/reported event provides them |
| Operations | Synthetic fixtures and local coordinator runtime | Live-provider verification, physical multi-host operation, cloud-feature parity, HA/failover, production readiness; hosted VM lifecycle, GitHub OAuth, repository checkout, PR creation, quotas, billing and service-level availability |

A successful chat turn is not evidence that every native harness feature was exposed. Treat agent working directories as trusted execution environments. See [network security](network-and-security.md).

## Claude Code, Codex, and Ollama

Claude Code is Anthropic's CLI coding agent; Anthropic's official documentation describes its setup, permissions, configuration, and supported workflows. This project does not reproduce Claude's hosted/cloud environment, account controls, isolated VM, repository integrations, or full approval experience.

OpenAI Codex is documented by OpenAI as a coding agent available through its own product surfaces and CLI. This adapter parses Codex `exec --json` as whole `item.completed` `agent_message` text, then chunks that complete text into API-safe display deltas. This is not token-level streaming, and no app-server delta events are accepted. A Codex CLI process remains distinct from Codex cloud: hosted workspaces, GitHub integration, PR automation, cloud execution and their security/approval model do not follow from CLI connectivity here.

Ollama provides local model serving and documented integrations with Claude Code and Pi. Its documented launcher pattern is `ollama launch claude` or `ollama launch pi`; the `--config` option is available for Pi. Manual compatible-provider configuration is also possible. These commands can alter local configuration and may trigger model acquisition depending on options: do not run them without the operator's approval. Ollama is a provider/runtime, not a replacement coding harness or an `AGENT_MODE`. In this checkout, adapter mappings accept `AGENT_PROVIDER=ollama` for Pi (provider/model flags), Codex (Ollama local-provider arguments), and OpenCode (provider/model namespace); Claude accepts it only with `ANTHROPIC_BASE_URL` configured and uses Anthropic-compatible environment settings. Mock ignores provider/model. Pi/Codex/OpenCode do not receive an Ollama-specific endpoint or credentials from the adapter. Configuration examples are not executed; fixtures exercise argument/environment construction only and establish no live compatibility. Ollama does not confer Claude/Codex hosted features. Provider base URLs, model names, and credentials belong on the worker and should be verified against current official documentation.

The six-high-advisory dependency issue remains a public-deployment blocker; see [dependency audit](DEPENDENCY-AUDIT.md). No live provider, physical multi-host, HA/failover, cloud-feature parity, or production readiness is established.

Official sources (consult current version-specific docs):

- Anthropic Claude Code overview: <https://docs.anthropic.com/en/docs/claude-code/overview>
- Anthropic settings and permissions: <https://docs.anthropic.com/en/docs/claude-code/settings>
- OpenAI Codex: <https://developers.openai.com/codex/>
- OpenAI Codex CLI: <https://developers.openai.com/codex/cli/>
- Ollama Claude Code integration: <https://docs.ollama.com/integrations/claude-code>
- Ollama Pi integration: <https://docs.ollama.com/integrations/pi>

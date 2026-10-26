# Declarative extension design

Runtime entry points follow the same declaration-first structure as `core/`:

1. Imports and types.
2. A top-level constants section containing Pi event names, command/tool metadata, action names, limits, paths, tones, and user-facing text.
3. Pure formatting/configuration helpers.
4. Runtime registration and handlers that refer to those declarations.

Pi lifecycle names come from `core/events.ts`. Standalone submodules keep a small local `pi-events.ts` so they remain installable by themselves. Event and command names must not be embedded directly in `pi.on(...)` or `pi.registerCommand(...)` calls.

Shared UI is declarative too. Extensions register a `RightPanelTab` with `core/right-panel.ts`; the core registry owns ordering, active state, rendering, shortcuts, and collapse behavior. An extension owns only its tab declaration and line producer. Tabs must be disposed when their feature is disabled or permanently shut down.

Markdown owns model-facing policy and configuration where live editing is useful: `rules.md`, `contexts.md`, and `commands.md`. TypeScript owns host integration, validation, and execution.

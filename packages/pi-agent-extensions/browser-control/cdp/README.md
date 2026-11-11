# CDP browser control (tools layer)

Pi tools layer for the CDP browser-control extension, per `contract.ts` (do not change
the contract without telling the manager). bc_cdp owns the controller side
(`controller.ts`, `client.ts`, `ownership.ts`, `detector.ts`, `guard.ts`, `pacing.ts`,
`snapshot.ts`, `launch.ts`); this layer owns only registration and result mapping.

## Files
- `index.ts` — default export `browserControlCdp(pi, deps?)`; creates the controller
  lazily on first use (no browser connection at load time), registers the `/bc`
  slash command, and closes the controller on `session_shutdown`.
- `tools.ts` — registers the 13 tools in `TOOL_NAMES`, each delegating verbatim to
  `controller.call(agent, name, params)`.
- Registered in `packages/pi-agent-extensions/package.json` under `pi.extensions`
  as `./browser-control/cdp/index.ts`.

## Agent id
Resolved per call: `deps.agent?.()` ?? `$H1_SELF` ?? `"pi"`. Ownership is enforced by
the controller: an agent only sees and touches tabs it opened via `tab_open` or that
the user assigned with `/bc assign`.

## Result mapping
Results are surfaced, never thrown. `OkResult` -> text content (plus an image block
for `screenshot`). `StopResult` / `ErrorResult` -> text content = `message` and
`details` = the result object itself, so the agent reads the STOP reason/code.

## /bc command
- `/bc status` — connection, agent id, owned tabs, active halt.
- `/bc launch` — launch Brave via bc_cdp's `launchBrave` (never auto-called by a tool), then connect.
- `/bc assign <tabId> [agent]` — user-initiated assignment of an existing tab.
- `/bc resume` — clear the detector halt after the user has handled a block.

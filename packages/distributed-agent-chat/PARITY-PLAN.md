# UI parity plan

Reference: `report.md`, Coverage section. Its 45 entries have non-contiguous original IDs (1–48); IDs below are preserved, not renumbered. No private sessions are copied into fixtures. Current equivalents describe the inspected exported `src/ui.ts`, not promises that proposed controls already work. UI worker owns source; audit worker owns this plan and parity tests.

Frozen source checkpoint: `src/ui.ts` file SHA256 `4987afb471bf54d60427551837de0c983522e2324e3ef2b711f4e4e65d284d04`. All Current/Gap entries below were reconciled against this checkpoint. File hash differs from the browser script's SHA256 of the exported HTML string.

## Complete 45-element inventory

| Report action / element (original ID) | Current ui.ts equivalent | Gap / supported equivalent vs boundary | Priority (H/M/L) |
|---|---|---|---|
| 1 sidebar-toggle: Hide/Show sidebar | `#sidebar-toggle` desktop, `#menu` mobile | Landed: collapse/expand, ARIA labels/state; browser verification required | H |
| 2 wordmark link /new | Static Session Code brand | Boundary: own brand; may return to local new session, never link to Claude chat home | L |
| 3 mode-radio: Claude | `#agent option[value=claude]` | Supported agent-selection equivalent; not a Claude website mode/navigation clone | M |
| 4 mode-radio: Code | `#agent option[value=pi]` | Local alternate agent equivalent (Pi); does not claim Pi equals Code mode | M |
| 5 New /code | `#new-session` | Supported local new-room flow; unique room, not remote cloud draft | H |
| 15 Artifacts /code/artifacts | None | Boundary: no artifact backend; no dead navigation | L |
| 16 new-from-template | None | Gap: local prompt templates can populate draft; no remote template catalogue | M |
| 6 Customize /customize | None | Boundary: no customization service; local preferences only if implemented | L |
| 7 More navigation items | None | Gap: minimal local navigation/help menu, not fabricated destination pages | M |
| 17 Pinned section toggle (blocked in report) | `.group-label` Pinned from local metadata | Supported grouping; independent pinned collapse toggle remains absent | M |
| 8 recents-collapse | `#recents-toggle[aria-expanded]` | Landed: hides/shows `#recents`; verify DOM visibility | H |
| 9 group-sort | `#recents-sort` menu: updated/name, pinned grouping | Landed local sorting/grouping; sort preference persistence remains a gap | H |
| 10 New session (+ in Recents) | `#new-session` outside header | Supported equivalent; header shortcut may reuse same unique-room action | M |
| 18 session link: Agent log footprint removal | `.recent-open`, local label, tooltip, `updateRoomTitle()` | Supported local navigation/title; no source current-session import | M |
| 20 session link: Codex reset watch and quota monitoring | `.recent-open`, local label, tooltip, `updateRoomTitle()` | Supported local navigation/title; no source session import | M |
| 22 session link: labs status desk (1) | `.recent-open`, local label, tooltip, `updateRoomTitle()` | Supported local navigation/title with distinct room identity | M |
| 24 session link: labs status desk (2) | `.recent-open`, local label, tooltip, `updateRoomTitle()` | Same component, distinct ID despite repeated source title | M |
| 26 session link: System 1 orchestrator skills | `.recent-open`, local label, tooltip, `updateRoomTitle()` | Supported local navigation/title; no remote presence/mark-read writes | M |
| 28 session link: GitHub login and AWS setup | `.recent-open`, local label, tooltip, `updateRoomTitle()` | Supported local navigation/title; no GitHub capability implied | M |
| 30 session link: bourbon-agent-cli-lab | `.recent-open`, local label, tooltip, `updateRoomTitle()` | Supported local navigation/title; no source conversation import | M |
| 32 session link: getCurrentTools error in macOS browser control | `.recent-open`, local label, tooltip, `updateRoomTitle()` | Supported local navigation/title; tooltip reveals ID, not full renamed label | M |
| 19 row menu: Agent log footprint removal | Shared `.row-menu-btn` | Landed local rename/pin/archive/remove/undo; no remote deletion | H |
| 21 row menu: Codex reset watch | Shared `.row-menu-btn` | Landed same component; verify open/Esc/focus | H |
| 23 row menu: labs status desk (1) | Shared `.row-menu-btn` | Local metadata scoped to this room identity | H |
| 25 row menu: labs status desk (2) | Shared `.row-menu-btn` | Independently scoped despite duplicate source title | H |
| 27 row menu: System 1 orchestrator skills | Shared `.row-menu-btn` | Same local menu; no invented local/cloud Fork capability | H |
| 29 row menu: GitHub login and AWS setup | Shared `.row-menu-btn` | Same local menu; no GitHub action implied | H |
| 31 row menu: bourbon-agent-cli-lab | Shared `.row-menu-btn` | Removing recent does not delete server history | H |
| 33 row menu: getCurrentTools error | Shared `.row-menu-btn` | Same local menu; Escape restores trigger focus | H |
| 11 account-menu | `#account-control` opens `#ui-details` | Landed local account/connection explanation and authenticated disconnect; no token copy/display action | H |
| 35 send-feedback-disabled | None | Local explicitly disabled affordance with reason; no silent click or third-party injection | M |
| 13 search-palette | Inline `#search` filters IDs and local labels | Supported inline search equivalent; modal palette is not yet implemented | H |
| 14 sidebar-resize | `.sidebar-resizer[role=separator]` | Landed: pointer drag, Left/Right/Home/End, 200–400 bounds, aria-valuenow and persisted width; verify browser | H |
| 37 Choose environment (main header) | Static fleet card | Gap: local worker/environment capability explanation; share picker semantics with toolbar | M |
| 38 Prompt textbox | `#prompt` textarea | Supported drafting; preserve draft during non-destructive UI interactions | H |
| 39 composer-add-menu | `#composer-add` menu | Landed code-block insertion and attachment-unavailable explanation; no file upload | M |
| 40 Send | `#sendButton`, centralized `updateSendState()` | Supported: empty/whitespace, disconnected and sending disabled; input/codeblock/connect/completion/disconnect update state; pending transient retry preserved | H |
| 41 Press and hold to record | None | Boundary: no speech capture pipeline; do not request microphone permission | L |
| 42 env-picker: Default | `#environment-control` explanation dialog | Supported truthful worker-host capability boundary, not fake environment selection | M |
| 43 Add repository | None | Boundary: no repo provisioning/auth API; explain worker checkout context instead of fake selection | M |
| 44 Branch | None | Boundary: cannot change worker checkout via this API; expose known context only, no invented branch state | M |
| 45 permissions-picker: Auto | `#permissions-control` explanation dialog | Supported worker permission boundary; no UI override without backend enforcement | H |
| 46 model-picker | `#agent` plus `#agent-capabilities` dialog | Supported agent/worker capability explanation, not invented selectable model list | M |
| 47 usage-meter | `#usage-control` unavailable explanation | Supported boundary disclosure: no measured quota/cost API or fabricated numbers | M |
| 48 pixel mascot (decorative) | `.spark[aria-hidden=true]` | Supported decorative equivalent, not interactive/trademark mascot | L |

Latest selector alignment: UI worker Batch 1 and initial Batch 2 edits landed during this audit. `.recent-open` supplies `title='Room: '+name` and local labels; `updateRoomTitle()` updates tab title on connect/switch/rename. Manager's final correction centralizes send state and guards whitespace without discarding pending retries. Row menus, recents collapse, resize, composer Add/options and capability/account explanation dialogs now exist. Templates, disabled feedback and independent pinned toggle remain gaps. The main-header environment copy is still a static card. Session-row-tooltip and session-links-title apply to **each** of the eight explicit link rows above. All eight menu rows map independently to the common local row component, not eight copied private records. Report sampling/skips do not constitute local test coverage.

## Parity boundaries

Will implement local sidebar collapse/resize (pointer and keyboard), recents collapse/sort/search, safe local metadata, accessible menus with Escape/focus restoration, prompt utilities, truthful capability explanations and responsive overflow handling.

Will **not** implement:
- Billing/subscriptions: no billing service or authoritative account plan data.
- Trademark branding: retain Session Code identity, not the Claude wordmark/mascot.
- GitHub authentication, repository provisioning or branch mutations: no supporting API; existing worker checkout is a separate capability.
- Intercom/third-party feedback injection: no integration; unavailable feedback must be visibly disabled with a reason.
- Invented metrics, model lists, environments or permission changes: only actual backend/worker facts may be shown.
- Remote archive/delete/share/fork semantics: local rename/pin/hide is metadata only, not deletion of durable room history.
- Voice recording, attachment upload and remote artifact/customization pages until real pipelines exist; no enabled dead controls.
- Token copying, token display, token persistence or token-bearing URLs. Disconnect clears in-memory authentication.

Environment and permissions are **real worker-capability concepts**, not Cloudflare billing features. The agent host/runtime/checkout defines environment, and the configured CLI permission policy controls tools. The present chat API does not expose authoritative selection or enforcement for these settings. Explain the boundary; do not suggest a cosmetic picker changes execution policy.

## Implementation order for UI worker

### Batch 1 — shell, navigation and accessibility
1. Desktop/mobile sidebar collapse, resize drag + keys with clamped width and separator ARIA; persist only non-secret preferences.
2. Recents collapse, sort/group, pin/rename/hide local metadata; all repeated rows use the same accessible component with full-title tooltips.
3. Search palette/filter and row/account menus: opening focus, Escape dismissal, focus restoration; update room/page title without token-bearing navigation.
4. Verify narrow layouts (320/390/760px), resized desktop and draft preservation; no horizontal overflow or unreachable controls.

### Batch 2 — truthful composer/capability surfaces
1. Prompt tools/templates and agent selection; initial/disconnected/empty draft send disabled. No upload or microphone permission requests.
2. Model/environment/repository/branch/permissions/usage explanations reflecting actual worker capabilities or explicitly unavailable state.
3. Disabled feedback reason; local workspace disconnect/account menu, no Copy token.
4. Run strict structural and isolated browser suites after selectors land; fix failures rather than downgrade assertions.

## Test boundaries and execution

`test/ui-parity.test.ts`: Miniflare GET `/` structural assertions only. No interaction claims. Client-created row controls are checked as source construction markers here and as rendered DOM in browser tests.

`scripts/parity-browser.ts`: imports the current exported HTML; ephemeral `127.0.0.1` server and fresh Playwright context, no fleet connection or secrets. Exercises actual DOM, local fixture metadata, pointer/keyboard actions and focus. Missing controls fail, never diagnostic-pass. Its 22 cases are not 45-element interaction coverage: source-only boundaries, unavailable controls, connected sending/disconnect (tested only in the separate fixture script), model execution, and all original private sessions are not exercised by the 22-case no-API suite. Local rename/pin/archive/remove tests use synthetic fixtures, not copied sessions.

`scripts/parity-connected.ts`: **separate local test-only API fixture**, not the no-network suite. Serves synthetic history/events/send responses on an ephemeral loopback server, uses a synthetic token, and deliberately serves one 503. Verifies connected empty/whitespace/sending/input/codeblock/completion/disconnect states, unchanged pending retry ID/payload after whitespace submission, and connect/switch/rename tab titles. This is browser UI evidence against a fixture, not provider or fleet integration evidence.

`test/ui.browser.mjs` remains unchanged: it is a live opt-in integration script and does **not** cover the new menu/resize/recents interaction requirements. Actual run outcomes are recorded in `/tmp/session-chat-audit-progress.md`.

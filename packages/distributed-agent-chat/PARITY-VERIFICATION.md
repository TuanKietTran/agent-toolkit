# UI parity review bundle

## Changed artifacts
- `src/ui.ts`: sidebar collapse and pointer/keyboard resize; recents collapse/search/sort; local alias/pin/archive/delete+Undo; keyboard menus; composer Add/options; truthful agent/environment/permissions/usage/account dialogs; tab-only disconnect; draft-aware send state and room/alias tab titles.
- `PARITY-PLAN.md`: explicit mapping of all 45 report elements, including unsupported boundaries. Mapping is not a claim of 45 browser-tested interactions.
- `test/ui-parity.test.ts`: seven static structure assertions, no missing-control pass-through.
- `scripts/parity-browser.ts`: isolated current-source browser suite, ephemeral loopback server, no backend/provider requests.

`test/ui.browser.mjs` is unchanged. No protocol or worker implementation changes, push or deployment.

## Manager verification of final source
- Source file SHA256: `4987afb471bf54d60427551837de0c983522e2324e3ef2b711f4e4e65d284d04`.
- Exported HTML SHA256: `df6a5f4c409c3938148b80446bcd95df9bf861f263dfe8ac5ace6e53da4f9ca4`.
- `npm run build`: PASS.
- `npm test`: PASS, 24/24 (includes seven static parity checks; not 24 browser cases).
- `npx tsx scripts/parity-browser.ts`: PASS, 22/22 browser cases after send-state/title fixes. Includes hostile-label literal rendering, persisted local metadata, rename/pin/archive/delete+Undo, menu/dialog keyboard focus, composer drafting, resize and mobile overflow.
- Separate connected composer fixture: pending. This will simulate a local chat API, not claim provider evidence.
- `git diff --check`: PASS.

## Screenshots
Generated from the same final exported source using only local fixture room labels; ignored output:
- `.deploy/screenshots/parity-desktop-1440.png`
- `.deploy/screenshots/parity-mobile-390.png`
- `.deploy/screenshots/parity-mobile-390-sidebar.png`

## Limits
No real-provider chat was rerun for these UI changes. Existing live fleet and its opt-in browser harness were preserved. Unsupported provider models, tool permissions, billing/quotas, account identity and file uploads are explicitly unavailable rather than simulated. No deployment is authorized by this bundle; commander visual/code review remains required.

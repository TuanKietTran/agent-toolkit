# A4 alpha-tooling report

## Integration changes

- Combined aggregate runtime, peer, and check/test/build dependencies in `packages/pi-agent-extensions/package.json:14-43`; the package remains Node `>=20` (`package.json:6-8`). Added local TypeScript, Node types, Pi API/TUI types and direct Typebox/Pi API peers. Regenerated the one aggregate `package-lock.json` with npm.
- Removed workstation-specific Homebrew `typeRoots` and `paths`, and excluded `dist`, native build output/dependencies and the deliberately manual browser live-watch test from TypeScript checking (`tsconfig.json:1-16`). Strict checking remains enabled.
- Expanded test command to run core, Claude CLI, browser temporal tests, Touch Bar tests and integration tests; it builds first so tests verify source and built package (`package.json:14-18`).
- Hardened `scripts/minify.mjs`: copies `.mjs`, Swift/native, Markdown and CLI resources with file modes; filters tests/dev/build artifacts; keeps core's readable-copy behavior; rewrites non-core `.ts` imports; and now errors on any missing declared output entry (`scripts/minify.mjs:10-68`).
- Added source/dist manifest existence, runtime asset/mode, and fake-host registration checks for every declared source and built entry (`tests/layout.test.mjs:1-62`). Added relocated browser entry to the core declarative registration test and made the shared Pi test loader resolve local installed Pi packages before the Homebrew fallback (`core/dev/declarative-design.test.ts:8-24`; `core/dev/pi-root.mjs:1-38`).
- Updated aggregate README installation/migration/build guidance (`README.md:172-213`).

## Source-to-dist mapping

- Every manifest `./*.ts` and `./feature/index.ts` becomes the corresponding `.js` path in `dist/package.json`; relative imports targeting non-core TypeScript are rewritten from `.ts` to `.js`.
- `core/**` is copied readable and retains its runtime Markdown; tests and `core/dev/**` are excluded from the built package.
- Runtime assets are copied at their relative paths: `touchbar-usage/src/{usage.mjs,runtime-files.mjs}`, `touchbar-usage/{host/main.swift,host/build.sh,bin/pi-usagebar}`, `browser-control/native/{chrome-control.js,macos-controller.swift}`, and Claude CLI docs/license. No native binary is shipped.

## Checks and results

- Initial exact strict TypeScript diagnostics (before the authorized type-only fixes):
  ```text
  remote-control.ts(352,3): error TS2322: Type 'ChildProcessByStdio<null, Readable, Readable>' is not assignable to type 'ChildProcessWithoutNullStreams'.
    Types of property 'stdin' are incompatible.
      Type 'null' is not assignable to type 'Writable'.
  thinking-control.ts(98,11): error TS7053: Element implicitly has an 'any' type because expression of type '"reasoning_effort"' can't be used to index type '{ chat_template_kwargs: { [x: string]: unknown; }; }'.
    Property 'reasoning_effort' does not exist on type '{ chat_template_kwargs: { [x: string]: unknown; }; }'.
  ```
- Resolved package versions from `npm ls` after clean `npm ci`: `@earendil-works/pi-ai@0.87.1`, `@earendil-works/pi-coding-agent@0.87.1`, `@earendil-works/pi-tui@0.87.1`, `@types/node@22.20.5`, `typescript@5.9.3`, and `typebox@1.4.3`. A diagnostic probe with `@types/node@22.19.19` reproduced both errors, so adjusting this A4-owned type resolution does not fix them. The earlier 0.84.4 Pi API probe caused additional moved-feature/core diagnostics and was not a viable manifest resolution.
- Manager granted a narrow scope exception for only the two diagnostic sites. `remote-control.ts` now models the existing stdio tuple as `ChildProcessByStdio<null, Readable, Readable>` without changing `spawn` options; `thinking-control.ts` types the copied payload as `Record<string, unknown>` before deleting the dynamic key. No strictness was relaxed; these edits are type-only.
- `node tools/pkg.mjs ci pi-agent-extensions` — **PASS** after the authorized fixes: npm ci, strict `check`, `test` (29 passed, 0 failed), and `build:min` all succeeded.
- `npm test` — **PASS**, 29 tests, 0 failures. This runs `build:min` first and verifies all source and built manifest entries, all entries' fake-host registration, `.mjs`/Swift/native/Markdown/CLI resources, and executable modes. The scheduler URL regression test covers the actual Touch Bar usage `.mjs` location.
- `npm run build:min` — **PASS** (also executed through `npm test`); reports all 4 of 4 extension entries in dist.
- `mkdir -p .build && xcrun swiftc browser-control/native/macos-controller.swift -o .build/macos-controller` — **PASS**, compile-only; `.build` was removed afterwards.
- `git diff --check flatten/base` — **PASS**. Verified the compile output directory `/Users/handlerone/Downloads/agent-toolkit-lab/repo/wt/alpha-tooling/packages/pi-agent-extensions/.build` is absent after cleanup.
- Earlier aggregate check against Pi API 0.84.4 also found type mismatches in relocated Claude/browser and core sources. The package now uses 0.87.1 API types matching the local Pi host; those errors are gone. The manager-approved type-only changes resolved the two initial diagnostics; the final full aggregate CI command passes.

## Modified paths

`packages/pi-agent-extensions/{README.md,package.json,package-lock.json,tsconfig.json,remote-control.ts,thinking-control.ts}`, `packages/pi-agent-extensions/scripts/minify.mjs`, `packages/pi-agent-extensions/tests/layout.test.mjs`, `packages/pi-agent-extensions/core/dev/{declarative-design.test.ts,pi-root.mjs}`, and `packages/pi-agent-extensions/browser-control/tests/live-watch.ts` (one-line manager-authorized path fix). The only root-feature edits are the manager-approved, type-only fixes to `remote-control.ts` and `thinking-control.ts`. No other feature-owned `touchbar-usage/**`, `browser-control/**`, or `claude-cli/**` source was changed.

## Dependencies / known gap

Merged Pi API/TUI, Typebox, Node type, TypeScript and existing `playwright-core` requirements are recorded in the aggregate manifest/lockfile. Ownership exceptions are limited to the manager-approved type-only fixes at the two aggregate root diagnostics above and the manager-approved one-line A2 migration fix in `browser-control/tests/live-watch.ts:2`; no other root-feature paths were modified. Manager granted a narrow A2-path exception for the one-line migration repair in `browser-control/tests/live-watch.ts:2`, updating its import to `../index.ts`; the live-watch test remains deliberately excluded and was never run. The exact old package token `pi-touchbar-usage` appears only as the intentionally retained UA identity at `touchbar-usage/src/usage.mjs:44`; `claude-cli/index.ts` and `claude-cli` provider IDs are new feature paths/identities, not the old package token `pi-extension-claude-cli`. These intended identity/path grep hits were not renamed. No authenticated provider, keychain, browser action, real-home install, or live network test was run. `remote-control.ts` runtime `spawn` stdio options are unchanged, and `thinking-control.ts` retains its existing delete behavior.

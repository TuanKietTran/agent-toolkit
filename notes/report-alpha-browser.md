# A2 alpha-browser report

## Changes

Flattened the browser extension into the aggregate feature directory, removed its standalone npm package shell and local event map, and retained native assets/tests. The module now consumes the aggregate event map (`packages/pi-agent-extensions/browser-control/index.ts:10`) and resolves native resources alongside its new entry (`index.ts:144-146`). Test import now targets the neighboring temporal-capture module.

### Old → new paths

- `packages/pi-extension-macos-browser-control/extensions/macos-browser-control.ts` → `packages/pi-agent-extensions/browser-control/index.ts`
- `packages/pi-extension-macos-browser-control/extensions/temporal-capture.ts` → `packages/pi-agent-extensions/browser-control/temporal-capture.ts`
- `packages/pi-extension-macos-browser-control/native/**` → `packages/pi-agent-extensions/browser-control/native/**`
- `packages/pi-extension-macos-browser-control/tests/**` → `packages/pi-agent-extensions/browser-control/tests/**`
- `packages/pi-extension-macos-browser-control/LICENSE` → `packages/pi-agent-extensions/browser-control/LICENSE`
- `packages/pi-extension-macos-browser-control/README.md` → `packages/pi-agent-extensions/browser-control/README.md`
- Removed old package `package.json`, `package-lock.json`, `tsconfig.json`, `.gitignore`, and `extensions/pi-events.ts`.

Updated feature README paths/examples to use the new aggregate location (`packages/pi-agent-extensions/browser-control/README.md`, Install and Example sections).

## Checks

- `node --test packages/pi-agent-extensions/browser-control/tests/*.test.ts` — PASS (1 test; temporal capture rendering).
- `git diff --check` — PASS (no whitespace errors).
- Stale-path/import grep — no stale old package path, old temporal import, or local pi-events import in moved feature.

## Integration requirements / deferred

Former manifest declared peer dependencies `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, `typebox`; dev dependencies `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, `@types/node`, `typescript` (versions are recorded in the removed manifest in git history). Former native check: `mkdir -p .build && xcrun swiftc native/macos-controller.swift -o .build/macos-controller`; new relative source is `browser-control/native/macos-controller.swift`. Aggregate tooling owner must merge dependency needs and adjust any command paths.

Native compile, minified-layout resource resolution, platform-safe loading, and lifecycle registration tests were not independently validated here. The extension guards native execution by checking platform in its helper (`index.ts`, `helper()`); verify that import/enumeration remains inert on non-macOS and that minified assets resolve in aggregate acceptance. No live browser/watch checks run.

## Intentional stale-name hits

No intentional old-path references added. Historical name appears only in this report's migration map; package manager git history retains the removed standalone manifest.

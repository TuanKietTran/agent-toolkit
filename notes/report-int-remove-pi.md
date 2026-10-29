# int-remove-pi report

## Result

Deleted `packages/pi/**` in commit `f673bad` (`Remove host and container installer CLI package`). The worktree was based on integration head `174d214` and is `flatten/int-remove-pi`. No push or PR was made.

## Reference and dependency audit

Commands and results after deletion:

- `git grep -nE 'packages/pi([^-]|$)' -- packages skills` — no hits.
- `git grep -nE 'packages/pi([^-]|$)|pi install|pi:test' -- packages skills tools .github packages.json` — remaining hits only in int-docs-owned Pi extension documentation (below); no test command, import, script, CI row, or runtime data reader refers to the deleted CLI.
- `git grep -nE 'packages/pi([^-]|$)|pi install|pi:test' -- ':!packages/pi/**'` — before deletion, source hits were confined to package/pi itself plus documentation; after deletion, the repository-wide audit leaves `README.md:10`, the retired package row, and owned docs listed below. No `tools/**` or `.github/**` hits.
- `git grep -n 'packages/pi' -- README.md CONTRIBUTING.md packages.json` — root `README.md:10` still links to the deleted package; this is assigned to int-docs. `packages.json:19` retains the `pi` registry entry; int-registry owns its removal.
- `git diff --cached --check` (before commit) — clean. Post-commit worktree is clean apart from this report until its commit.

The removed package contained its own CLI, imports, scripts, tests, fixture extension files, manifest, lockfile, and TypeScript config. Search for `packages/pi([^-]|$)`, `pi install`, and `pi:test` outside the removed tree found no code/test/runtime dependency on it. No removed source path had an external consumer.

## Preserved functional Pi content and deferred documentation hits

The separate aggregate extension package remains intact (`packages/pi-agent-extensions/package.json:2`, package name `pi-agent-extensions`). Pi coding-agent integration references remain in that package; for example its `pi install` usage is documented at `packages/pi-agent-extensions/README.md:171,187`, `packages/pi-agent-extensions/browser-control/README.md:55`, and `packages/pi-agent-extensions/claude-cli/README.md:17`. They refer to installing/loading Pi extensions, not the deleted host/container installer CLI, and those README files are explicitly owned by int-docs. The functional contribution guidance `packages/pi-agent-extensions/claude-cli/CONTRIBUTING.md:17` (“live pi install”) is retained.

Required deferred ownership actions: int-docs should remove/rewrite the root `README.md:10` row and review the package README references under its ownership; int-registry should remove the obsolete `packages.json:19` `pi` entry. No files in those owners' scopes were edited here.

## Verification

- `git diff --cached --check` — passed before the deletion commit.
- `git grep -nE 'packages/pi([^-]|$)' -- packages skills` — no hits.
- Changed paths were exactly the 20 tracked files under `packages/pi/`, all deletions; modes were regular `100644`. No generated files, caches, secrets, or out-of-scope tracked edits.
- No package tests were run; the deleted package has no remaining runnable acceptance surface. The integration-wide final checks remain with int-verify.

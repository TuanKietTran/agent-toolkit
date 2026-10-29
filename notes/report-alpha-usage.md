# A1 alpha-usage report

## Incident 1 audit (completed before acceptance tests)

Prior session evidence is `notes/incident-1.md` and `logs/alpha-usage.jsonl`. The prior cleanup command was `rm -f "$HOME/.pi/usage-touchbar.json" "$HOME/.pi/usage-touchbar.txt"`; the incident note records that the live extension regenerated the cache at 2026-10-29 12:06:50. Neither real-home file has been inspected, recreated, written, or removed in this remediation. No other home-state cleanup is performed.

### Reassessment from the pre-remediation test source

The pre-remediation `touchbar-usage/tests/runtime.test.mjs` source captured in the session shows `os.userInfo` temporarily returning the test's `mkdtempSync` home for the dynamic import. `usage.mjs` resolves `HOME` and derives `STATE_DIR`, JSON/text paths, and the lease directory at module load, so those test paths were rooted in that temp home, not the real account home. The source then calls `refresh()` with a fresh cached state (which returns before fetching), calls it while a live lease is held (which returns the prior state), and finally calls forced refresh with explicit `fetchClaudeFn` and `fetchCodexFn` fixtures. Those supplied callbacks replace the production fetchers, so these refresh calls did not invoke `claudeToken()`, `codexAuth()`, the keychain command, credential-file reads, or `fetchJson()`/provider endpoints. The fake-host/source test checks the scheduler URL and reads extension source for registration strings; it does not import usage code or call fetch/credential paths.

**Finding for the evidenced test paths:** no real credential read or provider endpoint call is indicated by their source path; their state/lease writes and cleanup are under the test's temporary home. No lease, ledger, or settings write to real `~/.pi` is indicated by these tests. The preserved incident note identifies the separate unsafe cleanup command exactly: `rm -f "$HOME/.pi/usage-touchbar.json" "$HOME/.pi/usage-touchbar.txt"`. Thus the evidence supports the named JSON/text cache as the real-home paths removed by the reported test cleanup, and no other real-home `~/.pi` writes are evidenced.

**Evidence limit:** the session JSONL is an interactive terminal recording, not a complete process/file-access audit. This source-based conclusion covers the described prior test paths and the cleanup command preserved in `notes/incident-1.md`; it cannot prove that no unrelated, unrecorded process or manual command accessed credentials, contacted endpoints, or changed another real-home path. No such access is evidenced in the preserved record. This reassessment does not inspect any real-home file or rerun tests.

Implemented `PI_USAGE_HOME` as the first `resolveHome()` choice, normalized with `path.resolve`; without it the existing `os.userInfo().homedir` then `os.homedir()` fallback remains unchanged. Usage tests assign a new `fs.mkdtempSync` directory before dynamically importing usage and assert `STATE_DIR` is beneath its root and differs from `os.userInfo().homedir`. Fetch behavior in the usage test is replaced by fixture callbacks, so neither production fetcher nor credential reader is entered. Runtime helper tests also use only their own temporary roots. All test `rmSync` cleanup targets are those test-created roots or lease descendants within the same test root.

Source isolation check before acceptance: `runtime-files.mjs` honors the override; tests no longer override `os.userInfo`; the only usage import in the test suite is after setting the override; refresh receives fixture fetch functions; lease cleanup is confined to `usage.STATE_DIR` under the asserted test root. No acceptance suite was run until these checks were made.

## Changes and path mapping

Moved `packages/pi-touchbar-usage/**` to `packages/pi-agent-extensions/touchbar-usage/**`, removing the old tree. Added shared `touchbar-usage/src/runtime-files.mjs` and declarations, and retained `usage-roundrobin.ts`'s `./touchbar-usage/src/usage.mjs` scheduler URL while making it share home and atomic-file helpers. Feature imports use `../core/events.ts` and `../core/right-panel.ts`; local event map removed. Host build copies the helper alongside usage core. README documents the test/sandbox-only override. `pi-usagebar` executable mode and native/BTT/MTMR resources are preserved.

## Verification

- `node --test packages/pi-agent-extensions/touchbar-usage/tests/*.test.mjs` — PASS.
- `sh -n packages/pi-agent-extensions/touchbar-usage/host/build.sh` — PASS.
- `bash -n packages/pi-agent-extensions/touchbar-usage/bin/pi-usagebar` — PASS.
- `git diff --check` — PASS.
- Scope grep found no stale moved directory, wrong core import, or wrong scheduler URL. Intentional `pi-touchbar-usage/1.0` UA remains as a client identity; scheduler and regression-test references to `touchbar-usage/src/usage.mjs` are the intended path.

Audit hits: test `rmSync` calls clean their own `mkdtempSync` roots (one explicit lease child under its test's isolated state root); production core lease `rmSync` targets `LEASE_DIR` derived from `STATE_DIR`, and the atomic helper's `unlinkSync` only targets its unique temporary file. The host build's `rm -rf "$APP"` is existing app-build cleanup under `$HOME/Applications`; only shell syntax was checked, never run. `os.userInfo()` / `os.homedir()` remain as default resolver behavior and in tests solely to verify unchanged fallback and assert the sandbox differs from the account home. `$HOME` hits are shell resolver/build documentation/runtime conventions; no test uses it for state isolation. `~/.pi` hits document published state paths and CLI/install/auth locations; tests never read real home files. `PI_USAGE_HOME` is documented test/sandbox-only.

Native packaging is deferred to the integration macOS acceptance lane. The source-based finding and its evidence limits are detailed in the Incident 1 reassessment above. Current tests likewise pass fixture fetch callbacks and remain confined to temporary homes.

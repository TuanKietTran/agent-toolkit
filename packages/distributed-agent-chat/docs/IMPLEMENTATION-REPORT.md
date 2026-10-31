# Implementation and QA report

## Definitive round-2 verification

These results supersede round-1 results. Commands were run from the package root. Durations are elapsed wall-clock milliseconds measured around each command; Node-reported test durations are noted separately.

| Exact command | Exit | Duration | Result |
|---|---:|---:|---|
| `npm run build` | 0 | 1589 ms | TypeScript and esbuild passed; `dist/worker.js` 47.4 kb. |
| `npm test` | 0 | 39536 ms | **60 tests, 57 pass, 0 fail, 0 cancelled, 3 skipped, 0 todo** (Node duration 39081.0445 ms). The Windows EOF skips were `incomplete fixture closes stdout for parent while process remains alive`, `codex open stdout without terminal event is not success`, and `opencode open stdout without terminal event is not success`. |
| `npx tsx --test --test-concurrency=1 test/standalone.test.ts` | 0 | 3725 ms | 1 test, 1 pass, 0 fail, 0 skipped (Node duration 3020.4036 ms). |
| `npm run doctor` | 0 | 491 ms | “Secrets configured safely for 5 agent target(s). Doctor checks passed.” No setup run. |
| `npm audit --json` | 1 | 1970 ms | 6 high, 0 critical, 6 total: miniflare, sharp, undici, wrangler, ws, zod. No audit fix run. |
| `npm ls --all miniflare wrangler sharp undici ws zod` | 0 | 686 ms | miniflare@4.20251011.1; wrangler@4.45.0 (includes deduped miniflare); sharp@0.33.5, undici@7.14.0, ws@8.18.0, zod@3.22.3. |
| `BROWSER_BINARY='C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe' npx tsx scripts/parity-browser.ts` | 0 | 12406 ms | 22/22 browser cases passed. |
| `BROWSER_BINARY='C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe' npx tsx scripts/parity-connected.ts` | 0 | 4196 ms | All four local fixture groups passed: connect/completion; retry; activity/stream/cancel; titles/disconnect/token isolation. |

Both Brave suites were rerun as a conservative choice; neither result was carried forward. The exported HTML SHA256 was `c3e2ad107e42bf0ac0265ed3f58d72f227c023d5f8aabaabae08ada59e1a27db`, matching the round-1 exported HTML hash; no change in exported HTML was observed. This is not a source-file hash. Current `src/ui.ts` SHA-256 was `a0b00516b30686b224d43e0534b18d3eecd064a5abd5d9b66aa9db0b99ea3b87`.

The full test run printed the Windows workerd diagnostic `WSARecv(): #64 The specified network name is no longer available.` during SQLite tests. The run continued and passed with zero failures; this diagnostic is not a test failure. A post-run process query for package-attributed `brave`, `workerd`, or `node` processes returned no rows; none were killed.

### Round-1 history (superseded)

Round 1 reported `npm test`: 59 tests, 56 pass, 0 fail, 3 skipped; standalone E2E: 1/1; Brave `parity-browser`: 22/22; `parity-connected`: passed; and `npm audit`: 6 high / 0 critical. These are historical results, not the definitive round-2 verification above.

## Port and guard changes

The coordinator, setup, examples, and worker defaults have been unified on port **18877** (previous coordinator default 8787 and worker default 18877 were inconsistent). `test/config.test.ts` checks five defaults as text: the coordinator port fallback, setup output literal, `.env.example`, worker default URL, and `dev` script. It passed within the final `npm test` run reported above. This textual consistency check does not establish runtime transport or multi-host operation.

## Round-1 scope notes that still apply

### Standalone CLI E2E

`test/standalone.test.ts` starts `scripts/server.ts` on loopback with temporary Miniflare SQLite state and two independent `process.execPath --import tsx src/agent/cli.ts` children. They run `AGENT_MODE=mock`, arbitrary IDs `nodeA`/`nodeB`, unique worker IDs, and distinct 24+ character target tokens. Assertions cover agent discovery; client/worker auth separation and cross-target 401s; streamed output/history; event cursor reconnect; follow-up room-session continuity/resumed mock output; and cancellation of an active mock turn with unchanged coordinator-visible output after 100 ms. Heartbeat cancellation is implemented behavior, not directly observed by that 100 ms assertion. Child processes and temporary files are cleaned in `finally`.

Mock mode does not supply a provider-native session ID; this E2E proves coordinator session continuity, not provider-native session resume. Native adapter fixture tests cover provider protocol session behavior separately. Physical multi-host and HA/failover are unsupported and untested.

### Output and activity boundaries

Codex prompt delivery uses stdin, verified by synthetic fixture; no live provider CLI invocation was made. Standard `exec --json` JSONL events include `thread.started`, `item.completed`, and `turn.completed`. Completed `item.completed` `agent_message` text is chunked for API-safe display: whole completion text framed into display chunks, not token-level streaming. App-server deltas are not accepted. OpenCode implementation requires session idle and zero process exit; fixture evidence only, with no live CLI verification.

The safe activity fixture parser emits names/status and numeric values only where source events provide them. Unsupported per-harness metrics remain unavailable. Normalized output does not imply a complete tool transcript or native telemetry.

### Windows executable and live-runtime boundary

The adapter launches selected executables with `shell: false`. On Windows, `AGENT_BINARY` therefore must be an absolute path to a native `.exe`; `.cmd`/`.ps1` shims (including npm-installed Codex shims) and extensionless shebang entries cannot be executed this way. The coordinator doctor checks Node >=22, `.env` secrets, and readable build artifact; it does not launch the selected executable. Optional worker `AGENT_DOCTOR=1` is a separate `--version` execution. Do not claim or infer that an npm Codex shim works. Mock is exempt from Windows executable requirements.

Codex stdin prompt delivery and Codex/OpenCode lifecycle behavior have synthetic fixture evidence only; no live provider CLI invocation was made, by policy. Codex `exec --json` consumes standard JSONL lifecycle events; completed `item.completed` `agent_message` text is chunked for display, not token-level streaming. OpenCode implementation requires session idle plus zero exit; live CLI behavior is unverified.

### Documentation and deployment boundaries

README documents setup (`npm run setup`), build, doctor, and `npm start` (build plus explicit Node `.env` loading), as well as arbitrary targets, modes, and provider/model configuration (`AGENT_PROVIDER` and `AGENT_MODEL`). Ollama is a provider, not an `AGENT_MODE`; the adapter maps it per harness: Pi provider/model flags, Codex local-provider arguments, OpenCode provider/model namespace, and Claude only with `ANTHROPIC_BASE_URL` configured; Mock ignores provider/model. These mappings are not live-verified. Examples are configuration-only, with no install, pull, or provider request.

QA did not invoke `npm start`; it would start the persistent coordinator, which the user will start when ready. Setup creation is a round-1 fact; setup was not run during round-2 verification. Doctor passed without printing or reading secret values. Neither README nor this report constitutes a security or cloud-readiness certification. This report records observed results and does not certify provider parity, production readiness, physical multi-host support, or HA.

## Security and dependency evidence

See [Security review](SECURITY-REVIEW.md) for reviewed findings, fixes, test evidence, and residual limits. It is a review record, not a certification. See [Dependency audit](DEPENDENCY-AUDIT.md) for the locked graph, advisory details, migration attempts, and deployment blocker. The audit remains **six high advisories**; no fix was applied.

## Verification boundaries and remaining limits

- No live provider execution or provider invocation was performed; provider behavior is supported by synthetic fixtures only.
- No physical multi-host operation was verified. No high availability or failover claim is made.
- No cloud-feature parity was verified.
- This package is **not production-ready**; the six-high-advisory dependency finding remains a public-deployment blocker.
- `npm run setup` was not run in round 2; `.env` values were not copied or recorded. No persistent service, deployment, cloud action, or provider invocation was performed.

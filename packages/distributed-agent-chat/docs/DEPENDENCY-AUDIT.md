# Dependency audit and deployment blocker

## Current locked graph and audit result

The round-2 audit of the restored dependency graph recorded **six high advisories and zero critical**: `miniflare`, `sharp`, `undici`, `wrangler`, `ws`, and `zod`. Current locked versions and graph are in `package-lock.json`; definitive round-2 audit counts are recorded in [IMPLEMENTATION-REPORT.md](IMPLEMENTATION-REPORT.md). Historical investigation details from transient orchestration handoffs are summarized here; those handoffs are not part of the shipped evidence.

The locked direct packages are Wrangler **4.45.0** and Miniflare **4.20251011.1**. Wrangler 4.45.0 depends on Miniflare 4.20251011.1. Locked transitive versions include sharp **0.33.5**, undici **7.14.0**, ws **8.18.0**, and zod **3.22.3** (`package-lock.json`).

| Advisory package | Locked version | Runtime scope |
|---|---:|---|
| miniflare | 4.20251011.1 | Runtime relevant: `scripts/server.ts` imports and constructs Miniflare for the standalone coordinator. It is not dev-only in this application. |
| sharp | 0.33.5 | Transitive dependency in the locked graph; no direct application import identified. |
| undici | 7.14.0 | Transitive dependency in the locked graph; no direct application import identified. |
| wrangler | 4.45.0 | Wrangler CLI used by the local `dev` command. The reported command-injection advisory concerns Wrangler's deployment/CLI path, not the ordinary standalone coordinator runtime; exploitability through this package's commands was not demonstrated. |
| ws | 8.18.0 | Transitive dependency in the locked graph; no direct application import identified. |
| zod | 3.22.3 | Transitive dependency in the locked graph; no direct application import identified. |

The transitive versions above are verified in `package-lock.json` by package entries and resolved tarball/version records. The recorded audit identifies six high findings; no advisory IDs are asserted here.

## Migration attempts (not applied)

1. A staged Wrangler **4.156.0** / Miniflare **5.20261023.3-beta** graph was tried. Targeted `test/server.test.ts` and `test/room.test.ts` yielded **1 pass and 3 failures**: three server/SQLite-runtime tests failed during Miniflare construction because v5 requires a `workers` array and rejects legacy options used by the project. The staged graph also failed `npm run build` with TypeScript errors in `scripts/server.ts` and `src/agent/adapters.ts`. Pins were reverted; an incidental lockfile change was restored. The staged audit had zero highs, but that graph was not viable and is not the current lock.
2. Wrangler **4.114.0** with stable Miniflare **4.20260722.0** was investigated as a stable-v4 alternative. Its isolated exact graph audit still reported **four highs**: miniflare, sharp, undici, and wrangler. This was investigation only; no dependency files were changed by it.
3. The dependency investigation found Wrangler **4.130.0** already pins a Miniflare 5 alpha; sampled subsequent releases (4.131.0, 4.140.0, 4.145.0, 4.150.0, 4.155.0) use Miniflare 5 alpha/beta prereleases. Clearing the Wrangler advisory while retaining stable Miniflare 4 therefore was not established by the investigation. No Miniflare 5 API migration or replacement graph was applied.

Historical investigation notes include failed v5 tests and graph comparisons; these are historical results, not current locked versions. If a conflict arises, `package.json` and `package-lock.json` define the current graph.

## Decision and scope

**This remains a public-deployment blocker; no dependency fix has been applied.** Do not treat the staged zero-high audit as the current result. `npm audit fix` and dependency/lockfile changes are outside this evidence record. Reassessment requires a compatible runtime migration and a fresh audit plus relevant test/build verification. This report is an audit summary, not a claim that each transitive dependency is exploitable in every deployment configuration.

## Evidence map

- `package.json` and `package-lock.json` -> **Current locked graph and audit result** (direct dependency declarations and exact locked versions).
- Historical transient platform handoff -> migration attempts (failed staged v5 graph, stable-v4 audit, sampled later Wrangler graphs); these handoffs are not shipped evidence.
- `scripts/server.ts` -> **Runtime scope** (coordinator imports Miniflare).
- `package.json` -> Wrangler use by the local `dev` command. `scripts/deploy.ts` -> explicit `celld` deployment helper; it does not execute Wrangler. The recorded Wrangler advisory concerns its deployment/CLI path, not ordinary standalone coordinator runtime; exploitability through this package's commands was not demonstrated.
- `src/agent/adapters.ts`, `src/agent/worker.ts`, `src/auth.ts`, `src/worker.ts` -> corresponding findings in [SECURITY-REVIEW.md](SECURITY-REVIEW.md) (**current source fix**).
- `test/adapters.test.ts`, `test/guards.test.ts`, `test/auth.test.ts`, `test/room.test.ts`, `test/server.test.ts` -> [SECURITY-REVIEW.md](SECURITY-REVIEW.md) (**focused test evidence**).
- Historical transient security-review notes are summarized in [SECURITY-REVIEW.md](SECURITY-REVIEW.md) as provenance; they are not shipped evidence.

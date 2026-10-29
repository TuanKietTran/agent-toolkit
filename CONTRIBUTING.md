# Working on package families

The independently managed packages live under `packages/*`; reusable agent skills live in the root `skills/` collection. Related features are grouped into package families rather than treated as separate packages. The root tooling provides a uniform way to run each registered package's checks.

```sh
npm run list                         # packages
npm run changed                      # packages touched vs origin/main (plus dependents)
node tools/pkg.mjs ci pi-agent-extensions # install + check + test + build one package
node tools/pkg.mjs test pi-agent-extensions system-one
npm run ci                           # everything you changed, same as CI
npm run ci:all                       # everything
```

Verbs are `install`, `check`, `test`, `build`; a module without one is skipped. The commands per module live in [`packages.json`](packages.json) — that file is the contract. CI reads the same file, runs only the modules a PR touches (on the right OS), and exposes one `all-green` check for branch protection. Changes to `packages.json`, `tools/` or `.github/workflows/` run every module.

## Rules of thumb

- Work on one package family per branch: `<package>/<topic>`. Commits: `<package>: <summary>`.
- Cross-module dependency? Declare it with `dependsOn` in `packages.json` so dependents are re-tested.
- New package: add `packages/<name>/` with a README and registry entry. Skills belong in `skills/`, not as separate package identities.
- Keep module-specific docs in the module; keep this file about the repo.

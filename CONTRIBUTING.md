# Working on a module

Each directory under `packages/` is an independent module with its own toolchain and lockfile. Nothing is hoisted; the root only provides a uniform way to drive them.

```sh
npm run list                         # modules
npm run changed                      # modules touched vs origin/main (plus dependents)
node tools/pkg.mjs ci pi             # install + check + test + build one module
node tools/pkg.mjs test pi system-one
npm run ci                           # everything you changed, same as CI
npm run ci:all                       # everything
```

Verbs are `install`, `check`, `test`, `build`; a module without one is skipped. The commands per module live in [`packages.json`](packages.json) — that file is the contract. CI reads the same file, runs only the modules a PR touches (on the right OS), and exposes one `all-green` check for branch protection. Changes to `packages.json`, `tools/` or `.github/workflows/` run every module.

## Rules of thumb

- Work on one module per branch: `<module>/<topic>` (e.g. `pi/fix-installer`). Commits: `<module>: <summary>`.
- Cross-module dependency? Declare it with `dependsOn` in `packages.json` so dependents are re-tested.
- New module: add `packages/<name>/` with a README, add an entry to `packages.json` and the README table.
- Keep module-specific docs in the module; keep this file about the repo.

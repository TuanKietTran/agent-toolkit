# graphloop

Graphloop is the first concrete implementation of **prompts -> agents -> loops -> graphs**: a Rust crate that parses Graphspec (`.yah`) files and brings a team up as `h1` labs.

Each layer is owned by an existing piece, not reinvented here:

- **Loop engineering** — `h1`: retries, idle detection, and the per-agent loop live there; graphloop adds no second loop runner.
- **Graph engineering** — graphloop itself: `team` blocks, the plan, and the run manifest that the console and lab-gui read.
- **Harness engineering** — `harness` blocks describe how each agent is opened with `h1 open`.
- **Model choice** — system-one decides which concrete model sits in each node, with the `system_one` fallback when a pick fails.

The language is specified in [docs/graphspec.md](docs/graphspec.md) (the vault plus the appended Schema, Semantics, Error format, Run manifest, Orchestration rules, and Command line sections).

## 60-second quickstart

```sh
cargo build
graphloop check examples/team.yah
graphloop plan examples/team.yah
graphloop up examples/demo.yah
h1 console
graphloop down examples/demo.yah
```

(`graphloop` above is `target/debug/graphloop` after `cargo build`. `examples/demo.yah` is the harmless one: three detached `cat` labs, no agent needed.)

## Layout

- `src/` — the crate: `lexer.rs` / `parser.rs` (tokens, recursive-descent parser), `resolve.rs` / `load.rs` (substitution, references, pipeline glue), `schema.rs` (strict validation), `pick.rs` (system-one resolution), `plan.rs` (team -> open steps, edges, manifest), `cli.rs` (`check|plan|graph|up|down|runs|trace`), plus the shared-contract modules `ast.rs`, `spec.rs`, `diag.rs`, `manifest.rs`.
- `docs/graphspec.md` — the Graphspec specification.
- `editors/` — TextMate grammar (`yah.tmLanguage.json`), `language-configuration.json`, install notes (`README.md`), and the dependency-free validator `check.mjs`.
- `examples/` — `team.yah` (commander -> builder), `research-team.yah` (planner with researcher / builder / reviewer), `demo.yah` (harmless detached `cat` labs).
- `tests/fixtures/canonical.yah` — the canonical example the grammar checks run against.

## Secrets

A `.yah` file never contains a secret value. A `vault` block says where a secret lives, and `${vault.NAME.KEY}` references — allowed only inside an `env` map, so a secret never appears in a readable command line — are fetched only at `graphloop up` time, held in memory, passed in the process environment (never argv), and scrubbed from output. A missing secret opens nothing and no value ever lands in a manifest.

The fleet pattern switches backends without editing the block, because keys a provider does not use are ignored:

```yah
variable "secrets" {
  type    = "string"
  default = "dotenv"
}

vault "fleet" {
  provider = var.secrets
  path     = "fleet.env"
  secrets  = {
    FLEET_RUN_TOKEN = "FLEET_RUN_TOKEN"
  }
}

harness "worker" {
  kind  = "h1"
  role  = "worker"
  model = "haiku"
  open {
    command = ["cat"]
    env = {
      FLEET_RUN_TOKEN = "${vault.fleet.FLEET_RUN_TOKEN}"
    }
  }
}
```

```sh
graphloop up fleet.yah                    # dotenv (default)
graphloop up fleet.yah --var secrets=env  # same block, from the process environment
```

Providers: `dotenv`, `env` and `command` now; `1password`, `bitwarden`, `bitwarden-secrets` and `keychain` behind the same block. Full chapter: [docs/graphspec.md](docs/graphspec.md) “Secret vaults”. See also `examples/vault.yah`.

## Tests

```sh
cargo test --offline
node editors/check.mjs
```

`check.mjs` parses both editor JSON files, compiles every grammar regex in Node, and runs regex-level checks over the canonical fixture and every file in `examples/`; it must print PASS and exit 0.

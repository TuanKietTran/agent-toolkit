# graphloop

> **Moved:** the graphloop binary has merged into `h1` — `graphloop check|plan|graph|up|down|vault|runs|trace` are now `h1 check|plan|graph|up|down|vault|runs|trace`, same arguments and flags. See the Migration section of [`packages/h1/README.md`](../h1/README.md). This directory keeps the Graphspec document and the examples.

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
- `examples/` — `team.yah` (commander -> builder), `research-team.yah` (planner with researcher / builder / reviewer), `demo.yah` (harmless detached `cat` labs), `renewable-team.yah` (builder with `brief` / `resume_log` / `auto_rearm` renew fields), `vault.yah` (a dotenv vault referenced from an env map), `preview.yah` (lead -> worker pair that exercises every field `graphloop preview` reports), `preview-demo.yah` (a preview that deliberately warns: an empty variable and a missing cwd, in a file that still loads).
- `tests/fixtures/canonical.yah` — the canonical example the grammar checks run against.

## Previewing a team

`graphloop preview examples/preview.yah` prints, as JSON, what `graphloop up` would open for a team — without opening anything: no sessions are started, no process is spawned (system-one included), no files are written, and no run manifest is created. Vault secrets are never fetched and `${env.*}` references are never expanded, so a preview is safe to run anywhere, including in tests, and is deterministic: same file, same output.

The document is versioned (version 1) and stable enough to golden-test — `tests/fixtures/preview/` holds one golden per file in `examples/`:

- Top level: `version`, `team`, `source`, `root`, `prefix`, `nodes`, `edges`, `warnings`.
- Each node: `name`, `harness`, `role`, `parent`, `requested_model`, `model`, `model_label`, `model_status`, `tools`, `cwd`, `env`, and `open_command` (the printable `h1 open ...` string). A pinned node names its catalog label and concrete `provider/id`; a `system-one` node stays `pending` with `model: null` — preview never asks system-one to choose.
- `env` entries carry `key`, `value`, `source` (`literal` / `env` / `vault` / `mixed`) and `masked`. `value` is the template as written: literals in full, `${env.*}` / `${vault.*}` shown as references. The one exception is a literal whose key looks secret-bearing (it contains `KEY`, `TOKEN`, `SECRET`, `PASSWORD` or `PASSWD`): its value is replaced by `***` and `masked` is true.
- Non-fatal findings are collected in `warnings` (sorted by node, then code) instead of failing the preview; hard errors fail exactly as `check` does. Codes include `empty_variable` (a variable that resolves to an empty string), `missing_cwd` (a literal cwd that does not exist) and `unknown_model` (a model label outside the catalog — reachable when a preview is built from a spec in code; a `.yah` file that names an unknown model fails `check`, so it never reaches preview).

`examples/preview-demo.yah` is the warning case on purpose: an empty variable and a missing cwd, in a file that still loads. Its header shows the `unknown_model` shape as a comment, for the reason above.

The `h1` console can render the same document as a planned graph (its `--preview` mode), so the JSON and the picture never drift. In the console, `P` loads a preview file and `o` sorts; the full preview-mode key list is in the h1 README's "Preview mode" section.

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

Providers: all seven — `dotenv`, `env`, `command`, `1password`, `bitwarden`, `bitwarden-secrets` and `keychain` — behind the same block. Full chapter: [docs/graphspec.md](docs/graphspec.md) “Secret vaults”. See also `examples/vault.yah`.

## Vault & secrets

A `vault` block names a provider and which keys to fetch; `${vault.NAME.KEY}` references are resolved when a team is brought up, and the values are passed to the opened processes in their environment only. Choose the provider that matches where your secrets already live:

| Provider | Program | What it fetches |
|---|---|---|
| `dotenv` | none (file read) | `KEY=VALUE` lines from the file at `path`, relative to the `.yah` file (default `.env`) |
| `env` | none | the value from graphloop's own process environment under the referenced key |
| `command` | the first element of the `command` list | runs that command with `{ref}` and `{key}` substituted into its arguments; the value is its stdout |
| `1password` | `op` | the referenced 1Password item field, read with `op read` (an account can be named in the block) |
| `bitwarden` | `bw` | a Bitwarden item field with `bw get` — the password by default, or username, notes, uri or totp when the reference names one, or a custom field when the reference is in the form `item#field` |
| `bitwarden-secrets` | `bws` | a Bitwarden Secrets Manager secret by id, with `bws secret get`; the value is the `value` field of its JSON output |
| `keychain` | `security` | a macOS Keychain generic password, with `security find-generic-password` (an account can be named to distinguish entries that share a service) |

Three rules hold for every provider:

- **Names only in output.** `plan`, `graph`, `up --dry-run`, `runs`, `trace` and `vault status` print environment variable NAMES only — entries that come from a vault are marked as vault-sourced — and never print values. The run manifest likewise records only the `vault_env` names, never a value.
- **Failures name the program and its exit status only.** The four CLI providers (`1password`, `bitwarden`, `bitwarden-secrets`, `keychain`) share one failure path: when one fails, the error reports the program name and the exit status, and never quotes the provider's stdout or stderr, so nothing a provider prints can leak into an error message. A locked Bitwarden vault is reported as locked — `Bitwarden vault is locked: run: bw unlock` — instead of any provider output. The `command` provider's error likewise names its program and exit status; it may quote the first line of its stderr, scrubbed of any fetched secret values.
- **`--env-file` values stay out of output.** Values loaded with `--env-file` go into the environment of the processes graphloop opens, and into nothing else: they never appear in any command output.

## Tests

```sh
cargo test --offline
node editors/check.mjs
```

`check.mjs` parses both editor JSON files, compiles every grammar regex in Node, and runs regex-level checks over the canonical fixture and every file in `examples/`; it must print PASS and exit 0.

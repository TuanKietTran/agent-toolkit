# Graphspec (.yah) Vault — version 1

Independent declarative format. Not YAML. Not HCL. Own grammar.

## File identity

- Extension: `.yah`
- Magic header (first non-comment line): `yah 1`
- Encoding: UTF-8
- Comments: `//`
- Indentation: insignificant (braces define structure)

## Grammar (informal)

```text
file          := header statement*
header        := "yah" integer
statement     := block | assignment | comment
block         := identifier string? "{" statement* "}"
assignment    := identifier "=" value
value         := string | number | bool | null | list | map | reference | interpolation
list          := "[" (value ("," value)*)? "]"
map           := "{" (assignment)* "}"
string        := '"' [^"]* '"' | '`' raw '`'
reference     := identifier ("." identifier)*
interpolation := "${" expression "}"
comment       := "//" .*
```

## Vault rules

- Version declared in header
- Top-level blocks only (nested blocks allowed inside schema-defined values)
- Identifiers: `[a-zA-Z_][a-zA-Z0-9_-]*`
- Strings: double-quoted or raw backticks
- Interpolation: `${env.NAME}` `${var.name}` `${harnesses.builder.model}` `${defaults.log_dir}` and, inside harness-shaped blocks, `${name}` `${parent}` `${role}` `${member}`
- Booleans: `true` / `false` only
- Null: `null`
- Trailing commas allowed
- Secrets never stored — only `${env.*}`
- Strict mode: unknown keys or missing required fields = error

## Top-level blocks

| Block | Count | Purpose |
| --- | --- | --- |
| `variable` | 0..n | input variables |
| `defaults` | 0..1 | global defaults |
| `provider` | 0..n | LLM / API providers |
| `model` | 0..n | model catalog |
| `system_one` | 0..1 | system-one model-pick policy |
| `image` | 0..1 | image generation & vision |
| `api` | 0..n | MCP / HTTP tools |
| `prototype` | 0..n | reusable harness templates (see Templates and derivation) |
| `group` | 0..n | harnesses stamped from a prototype, one per member name |
| `harness` | 0..n | named agent harnesses (kind = h1) |
| `team` | 0..n | orchestration teams / graphs |
| `workflow` | 0..n | higher-level multi-step flows |
| `output` | 0..n | exported values |

## Canonical example (team.yah)

```yah
yah 1

variable "work_dir" {
  type    = "string"
  default = "./work"
}

defaults {
  model_policy = "system-one"
  sandbox      = "local"
}

provider "anthropic" {
  type    = "anthropic"
  api_key = env.ANTHROPIC_API_KEY
}

model "sonnet" {
  provider     = "anthropic"
  capabilities = ["chat", "tools", "vision"]
}

system_one {
  fallback = "sonnet"
  student  = "data/student_model.json"
}

api "fs" {
  type    = "mcp"
  command = ["npx", "-y", "@modelcontextprotocol/server-filesystem", var.work_dir]
}

harness "commander" {
  kind  = "h1"
  role  = "commander"
  model = "system-one"
  tools = ["fs"]
  open {
    command = ["pi", "--no-session"]
    cols    = 140
    rows    = 40
  }
}

harness "builder" {
  kind   = "h1"
  role   = "builder"
  parent = "commander"
  model  = "system-one"
  tools  = ["fs"]
  open {
    command = ["pi", "--no-session"]
    cwd     = var.work_dir
  }
}

team "default" {
  root    = "commander"
  members = ["builder"]
  graph   = true
}
```

## Parser requirements

1. Lexer → tokens
2. Recursive-descent / Pratt parser
3. Post-parse: resolve interpolations → resolve references → schema validation → apply defaults
4. Terraform-style errors with file:line

## Independence guarantees

- No YAML parser
- Indentation insignificant
- Own grammar, own vault schema, own error format
- Dedicated TextMate/tree-sitter grammar for `*.yah`

---

# Implementation notes

The sections below are the implementation contract built on the vault above. Each section cites the vault rule it implements. The vault text above is the specification and does not change.

## Schema

Strict mode (vault: "Strict mode: unknown keys or missing required fields = error"). Keys not listed for a block are an error. Types: `string` (double-quoted or backtick raw), `list`, `map`, `bool` (`true`/`false` only), `template` (a string that may contain `${...}` interpolation).

### `variable "<name>"` (0..n)

| Key | Type | Required | Default |
| --- | --- | --- | --- |
| `type` | string | yes | — |
| `default` | value of `type` | no | — (absent: must be supplied with `--var`) |
| `description` | string | no | — |

### `defaults` (0..1)

| Key | Type | Required | Default |
| --- | --- | --- | --- |
| `model_policy` | string | no | — |
| `sandbox` | string | no | — |
| `worktree_root` | template | no | — — **extension**: base directory for per-harness working trees, read as `${defaults.worktree_root}` |
| `log_dir` | template | no | — — **extension**: base directory for per-harness logs, read as `${defaults.log_dir}` |

### `provider "<name>"` (0..n)

| Key | Type | Required | Default |
| --- | --- | --- | --- |
| `type` | string | yes | — |
| `api_key_env` | string | no | — (names an env var; vault: secrets never stored) |
| `base_url` | string | no | — |

### `model "<name>"` (0..n)

| Key | Type | Required | Default |
| --- | --- | --- | --- |
| `provider` | string (a `provider` label) | yes | — |
| `id` | string | yes | — — **extension** beyond the canonical example: the concrete model id |
| `capabilities` | list of string | no | `[]` |

### `system_one` (0..1)

| Key | Type | Required | Default |
| --- | --- | --- | --- |
| `fallback` | string (a `model` label) | yes | — |
| `student` | string (path) | no | — |

### `image` (0..1)

| Key | Type | Required | Default |
| --- | --- | --- | --- |
| `provider` | string | yes | — |
| `generate` | string | no | — |
| `vision` | string | no | — |

### `api "<name>"` (0..n)

| Key | Type | Required | Default |
| --- | --- | --- | --- |
| `type` | string (`mcp` or `http`) | yes | — |
| `command` | list of template | for `mcp` | — |
| `url` | template | for `http` | — |
| `env` | map of template | no | `{}` |

### `harness "<name>"` (0..n)

| Key | Type | Required | Default |
| --- | --- | --- | --- |
| `prototype` | string (a `prototype` label) | no | — — **extension**: start from that template; own keys win |
| `kind` | string | yes | — (v1: must be `"h1"`; may come from the prototype) |
| `role` | string | yes | — (may come from the prototype) |
| `parent` | string (a `harness` label) | no | — |
| `model` | string (a `model` label, or `"system-one"`) | yes | — (may come from the prototype) |
| `tools` | list of string (`api` labels) | no | `[]` |
| `complexity` | string | no | — — **extension**: hint for system-one |
| `open` | block (below) | yes | — (may come from the prototype, merged key by key) |

### `open { ... }` (inside `harness`, exactly 1)

| Key | Type | Required | Default |
| --- | --- | --- | --- |
| `command` | list of template | yes | — |
| `cols` | number | no | h1's default when absent |
| `rows` | number | no | h1's default when absent |
| `cwd` | template | no | the caller's working directory |
| `env` | map of template | no | `{}` |
| `title` | template | no | the session name |
| `detached` | bool | no | `false` — **extension** beyond the canonical example |
| `brief` | template | no | — — maps to `h1 open --brief`: file whose contents re-arm the session on renew |
| `resume_log` | template | no | — — maps to `h1 open --resume-log`: log whose last lines re-arm the session on renew |
| `auto_rearm` | bool | no | `false` — maps to `h1 open --auto-rearm`: re-arm automatically when the session's new-command is submitted |

### `team "<name>"` (0..n)

| Key | Type | Required | Default |
| --- | --- | --- | --- |
| `root` | string (a `harness` label) | yes | — |
| `members` | list of string (`harness` labels) | no | derived: every harness reachable from `root` through parent edges (see Templates and derivation) |
| `include` | list of string (glob over `harness` labels) | no | `[]` — **extension**: adds every matching harness to the members |
| `exclude` | list of string (glob over `harness` labels) | no | `[]` — **extension**: removes matching harnesses from the members (never the root) |
| `graph` | bool | no | `false` |

### `workflow "<name>"` (0..n)

| Key | Type | Required | Default |
| --- | --- | --- | --- |
| `team` | string (a `team` label) | yes | — |
| `steps` | list of string | yes | — |

Parsed and validated in v1, not executed (see Semantics).

## Semantics

Pipeline (vault, "Parser requirements"): lexer → parser → resolve interpolations → resolve references → schema validation → apply defaults. On top of that:

- **Late binding.** Two interpolations are not resolved at load time (vault: "Interpolation: `${env.NAME}` `${var.name}` `${harnesses.builder.model}`"). `${env.NAME}` is read from the process environment when a command is rendered, never at parse time, so a file can be checked on a machine without the secrets. `${harnesses.<label>.model}` and `${harnesses.<label>.model_id}` are bound after model resolution, per harness.
- **Variables.** `var.<name>` resolves to the variable's `default`, overridden by `--var NAME=VALUE` (repeatable). A variable with no default and no `--var` is an error at resolve time.
- **Defaults.** The `defaults` block supplies values a harness does not set itself; a harness's own keys always win. Schema defaults from the tables above are applied after validation, before planning.
- **Edges.** A team's graph has two edge kinds. A `parent` key gives a parent edge `parent -> harness`. Every member with no parent gets a member edge `root -> member` from the team's `root`. The root itself has no incoming edge. Parents are opened before children (topological order, stable in declaration order). For the canonical example (vault, "Canonical example"):

```text
commander (root)
  └─ builder        (parent edge: commander -> builder)
```

A parentless member `reviewer` of the same team would add `commander -> reviewer` as a member edge.

- **Session naming.** Each harness becomes one h1 session named after its label, optionally prefixed: `--prefix P` names sessions `P-<label>`, which keeps teams from colliding. Session names must match `[A-Za-z0-9._-]`, be at most 40 characters, and not start with `.`.
- **Model resolution.** `model = "system-one"` is resolved by system-one (`packages/system-one`) at plan time, using the harness's `role` and `complexity` hint. If system-one cannot decide or cannot be located, the resolved model is the `system_one.fallback` model — that fallback, and only that fallback, as defined in the `system_one` block. A pinned `model = "<label>"` is never re-decided.
- **How the model reaches the program.** Only through interpolation: `open.command` (and `cwd`/`env`/`title`) may embed one of two model forms. `${harnesses.<label>.model}` is replaced by the resolved model in `provider_type/id` form (e.g. `anthropic/claude-sonnet-5-5`) — use it for programs that take a provider-qualified model; h1 itself passes that form to `h1 open --model`. `${harnesses.<label>.model_id}` is replaced by the bare model id (e.g. `claude-sonnet-5-5`) — use it when the program already knows the provider, as with `pi --provider claude-cli --model ${harnesses.<label>.model_id}` in `examples/research-team.yah` and `examples/team.yah`. h1 does not inject the model any other way.
- **`workflow` in v1.** `workflow` blocks are parsed, validated and listed, but not executed in v1. Loops live inside h1 (see Orchestration rules).

## Error format

Vault: "Terraform-style errors with file:line". Every diagnostic carries severity, file, line, column, a summary, a detail, the enclosing block as context, and an optional `Did you mean ...?` hint (for a name within edit distance 2 of a known one). Rendered:

```text
Error: Missing required argument

  on team.yah line 22, in harness "builder":
  22: harness "builder" {

The argument "role" is required, but no definition was found.
```

Lexer and parser errors stop at the first problem; resolve and schema errors are collected and reported together. `h1 check` prints the rendered diagnostics to stderr and exits 1; a valid file exits 0.

## Run manifest

`h1 up` writes one JSON manifest per run, before opening any lab, so the console and lab-gui can show planned nodes. It lives next to h1's session data, under a `graphs` directory: the base is `$H1_DIR` when set, else the same base h1 uses for its sessions (`$LOCALAPPDATA/h1/sessions` on Windows, else `$XDG_RUNTIME_DIR` or `$TMPDIR` or the system temp dir, joined with `h1`), plus `/graphs` (`src/manifest.rs`: `dir()` / `path_for(run)`). The file is `<graphs>/<run>.json`, written atomically (temp file in the same directory, then rename). Readers: the h1 console (Graphspec overlay) and lab-gui. Writer: only `h1 up`.

Top-level fields: `version`, `run` (run id), `team`, `source` (the `.yah` path), `root` (root session name), `created_ms`, `trace_dir` (or `null`), `nodes`, `edges`. Each node: `name` (session name), `harness` (label), `role`, `parent` (session name or `null`), `requested_model` (as written), `model` (resolved model id), `model_label`, `pick` (`via`, `rule`, `reason`, `degraded_level`), `tools`. Each edge: `from`, `to`, `kind` (parent or member, per Semantics).

Illustrative excerpt:

```json
{
  "version": 1,
  "run": "default-20261107-112000",
  "team": "default",
  "source": "examples/team.yah",
  "root": "commander",
  "nodes": [
    { "name": "builder", "harness": "builder", "role": "builder", "parent": "commander", "requested_model": "system-one", "model": "claude-sonnet-5-5", "model_label": "sonnet", "pick": { "via": "system-one", "rule": null, "reason": "role=builder", "degraded_level": 0 }, "tools": ["fs"] }
  ],
  "edges": [ { "from": "commander", "to": "builder", "kind": "parent" } ]
}
```

## Orchestration rules

Reproduced from the contract's "Launching" section:

1. Every harness is started via `h1 open ... --model <resolved>` — h1 never starts a harness program directly.
2. `model = "system-one"` is resolved by `packages/system-one`, with fallback only as defined in the `system_one` block.
3. The `team` block is the graph: nodes are harnesses, edges are `parent` plus `root -> member`. There is no other graph definition.
4. Loops stay inside h1; h1 adds no second loop runner.
5. Graphs are static: every node and edge is fixed when the file is loaded. `prototype`, `group`, `include` and derived `members` are expanded at load time, deterministically and without reading the machine, so `check`, `plan`, `graph` and the run manifest always show the same fully expanded nodes. Nothing is generated or discovered while a run is live.
6. One trace per run: with recording on, every session of the run records into the run's single trace directory.
7. `image` and `api` blocks are tools, not prompt text: they are handed to harnesses as tools and are never inlined into a prompt.

## Command line

Common flags: `FILE` (a `.yah` path), `--team NAME` (default: the only team, or an error listing them), `--prefix P`, `--var NAME=VALUE` (repeatable), `--detached`. Output samples below are illustrative.

- `h1 check FILE` — load, resolve and validate; print the counts or the rendered diagnostics (stderr), exit 0 / 1.
- `h1 plan FILE [--json]` — resolve models, build the plan, print each step's shell line preceded by a comment naming the resolved model. `--json` prints one JSON object instead.
- `h1 graph FILE` — print the team's edges (the graph of Semantics) without opening anything.
- `h1 up FILE` — write the run manifest (above), then open every step in plan order with h1; on a failed open, stop and roll back the labs this run already opened.
- `h1 down RUN` — stop every session named in the run's manifest; report what it stopped.
- `h1 runs` — table of manifests: run, team, nodes live/total, age.
- `h1 trace RUN` — list the recordings in the run's trace directory, with sizes and the node each belongs to.

```text
$ h1 check examples/team.yah
ok: 2 harnesses, 1 teams

$ h1 plan examples/team.yah
# harness builder: claude-sonnet-5-5 (via system-one: role=builder)
h1 open -n builder -- pi --provider claude-cli --model claude-sonnet-5-5 --no-session

$ h1 graph examples/team.yah
commander -> builder (parent)
```

### `output "<name>"` (0..n)

| Key | Type | Required | Default |
| --- | --- | --- | --- |
| `value` | template | yes | — |
| `description` | string | no | — |

## Editor support and examples

This package ships editor support for the graphspec / yah language under `editors/`:

- `editors/yah.tmLanguage.json` — TextMate grammar. Declaration keywords (`variable`, `defaults`, `provider`, `model`, `system_one`, `image`, `api`, `harness`, `team`, `workflow`, `output`) are scoped as declarations, and the quoted name following a declaration keyword is scoped as an entity name; strings, comments, numbers, and operators use the standard scopes documented in `editors/README.md`.
- `editors/language-configuration.json` — bracket, auto-closing, and comment configuration for editors that consume VS Code-style language configurations.
- `editors/check.mjs` — dependency-free validation: parses both JSON files and sanity-checks the grammar patterns. Run `node editors/check.mjs` from this package root; it must exit 0.
- `editors/README.md` — installation and scope notes.

Examples live under `examples/` (`team.yah`, `research-team.yah`, `demo.yah`) and illustrate the declaration forms above. The package overview, including how this document, the editor support, and the examples fit together, is in the package `README.md`.

# Templates and derivation

Extension to version 1 that removes repeated names and paths. It adds no new runtime concept: loading expands everything below into plain `harness` blocks and plain `team.members`, and every later stage (resolve, schema validation, plan, manifest) sees only the expanded result. A file that uses none of it behaves exactly as before.

Expansion order: `group` → `prototype` merge → `${name}`/`${parent}`/`${role}`/`${member}` substitution → team membership → the usual resolve and schema validation.

## `prototype "<name>"` (0..n)

A harness with every key optional and no `parent`. It may carry `extends = "<prototype label>"` to build on another prototype (cycles are an error). Keys are exactly the `harness` keys; `open` is the same block.

```yah
prototype "worker" {
  kind  = "h1"
  role  = "worker"
  model = "muse"
  open {
    detached = true
    command  = ["pi", "--provider", "muse", "--model", "muse", "--no-session"]
    env      = { FLEET_RUN_TOKEN = "${vault.fleet.FLEET_RUN_TOKEN}" }
  }
}

harness "w-prov" {
  prototype = "worker"
  parent    = "cmdr-vault"
  open {
    title = "${name}: vault providers"
    cwd   = "${defaults.worktree_root}/${name}"
  }
}
```

Merge rule (prototype, then the consuming block on top; the consumer always wins):

- scalar keys: the consumer's value replaces the prototype's;
- `list` values (`command`, `tools`): replaced whole, never concatenated;
- `map` values (`env`) and the `open` block: merged key by key, consumer's key wins;
- a key set to `null` in the consumer removes the inherited key.

Required keys are checked after the merge, so a prototype may leave `role` unset for the consumer to supply. A prototype that no harness or group uses is valid and ignored. `h1 check` reports an unknown prototype label with a `Did you mean ...?` hint.

## Name interpolation

Inside `harness`, `group` and `prototype` blocks (including their `open` block), these resolve at expansion time:

| Form | Value |
| --- | --- |
| `${name}` | the harness label being defined (for a group member: prefix + member) |
| `${parent}` | the label of the harness's `parent`; an error if it has none |
| `${role}` | the harness's `role` after merge |
| `${member}` | inside a `group` only: the bare member name, without the prefix |

Templates written in a prototype are substituted against the harness that uses the prototype, not against the prototype. These forms are errors in any other block. `${name}` is the label, before `--prefix`; session naming (Semantics) still applies afterwards, including the 40-character limit.

## `group "<name>"` (0..n)

Stamps one harness per member from a prototype, with a shared parent.

| Key | Type | Required | Default |
| --- | --- | --- | --- |
| `prototype` | string (a `prototype` label) | yes | — |
| `parent` | string (a `harness` label) | no | — |
| `prefix` | string | no | `""` — each harness label is `prefix` + member |
| `members` | list of string | yes | — |
| `open`, `model`, `role`, `tools`, `complexity` | as in `harness` | no | override the prototype for every member |

```yah
group "vault-workers" {
  prototype = "worker"
  parent    = "cmdr-vault"
  prefix    = "w-"
  members   = ["prov", "envf", "docs", "alias"]
  open {
    cwd = "${defaults.worktree_root}/${name}"
  }
}
```

The example defines `w-prov`, `w-envf`, `w-docs` and `w-alias`, in member order. A generated label that collides with an explicit `harness` or another group's label is an error, with both locations. Members are listed in the file; a group never reads the disk or the environment to decide who exists.

## Derived team membership

`team.members` is optional. When omitted, the members are every harness reachable from `root` by following `parent` edges downward (the root's children, their children, and so on). `include` adds every harness whose label matches one of its globs (`*` any run of characters, `?` one character; case-sensitive; the whole label must match). `exclude` then removes matches. An explicit `members` list is unioned with the derived set, so listing it stays valid but is no longer needed. The `root` is always a member and is never excluded.

A member with no parent still gets the member edge `root -> member` (Semantics, Edges), so an `include`d parentless harness hangs off the root. Order is declaration order, with generated group harnesses at the position of their `group` block.

```yah
team "fleet" {
  root    = "claude"
  graph   = true
  include = ["cmdr-*"]
}
```

## `defaults` paths

`worktree_root` and `log_dir` give derived locations one home: `cwd = "${defaults.worktree_root}/${name}"` ties a directory to a label without repeating either. `${defaults.<key>}` may be used in any template; an unset key is an error at resolve time, like an unset `var`.

A status board does not need to list logs. Under the same `log_dir`, a harness can run `sh -c "cd ${defaults.log_dir} && tail -n 3 -F *.log"`; the glob is expanded by the shell at run time, so adding or removing a worker needs no edit here.

## Errors added

- unknown or cyclic `prototype` / `extends`;
- `${parent}` in a harness with no parent; `${member}` outside a group; any name form outside harness-shaped blocks;
- label collision between harnesses and generated group harnesses;
- `include`/`exclude` glob that matches no harness (warning, not error, for `include`; error for an `exclude` that names the root);
- unset `${defaults.<key>}`.

# Secret vaults

A `.yah` file never contains a secret value. It contains a `vault` block that says *where* a secret lives, and references of the form `${vault.NAME.KEY}` in the places that need it. Nothing is read at parse, `check` or `plan` time: values are fetched only when `h1 up` opens a lab.

## The `vault` block

```yah check
yah 1

vault "local" {
  provider = "dotenv"
  path     = "fleet.env"
  secrets  = {
    FLEET_TOKEN = "FLEET_TOKEN"
    GH_TOKEN    = "GITHUB_TOKEN"
  }
}
```

| Key | Type | Required | Meaning |
| --- | --- | --- | --- |
| `provider` | string | yes | Which adapter fetches the values (see the provider table below). May be a variable reference, for example `provider = var.secrets`, so the backend can be switched from the command line. |
| `path` | string | no | File for the `dotenv` provider: a `KEY=VALUE` file, relative to the `.yah` file (a leading `~/` is expanded against `$HOME`). Default `.env`. |
| `account` | string | no | Provider account or server. Used by `1password` (as the `op --account` value) and by `keychain` (to distinguish entries that share a service); ignored by the other providers. |
| `command` | list of strings | for `command` only | Argv template for the `command` provider. `{ref}` and `{key}` are substituted in each element; the value is the command's stdout. |
| `secrets` | map of string to string | no | Maps each KEY used in `${vault.NAME.KEY}` to the provider-side reference for that key. If `secrets` is absent or a key is not listed, any KEY is allowed and the KEY itself is the reference. Duplicate keys are an error. |

Keys a block carries for a provider that does not use them are accepted and ignored on purpose: one block can carry the settings of every backend, which is what makes `provider = var.name` switching (below) work without editing the block.

## References: `${vault.NAME.KEY}`

```yah
harness "worker" {
  # ...
  open {
    command = ["cat"]
    env = {
      FLEET_TOKEN = "${vault.local.FLEET_TOKEN}"
    }
  }
}
```

- `${vault.NAME.KEY}` is allowed **only inside an `env` map**. Anywhere else it is a validation error. The reason is exposure: a command line is readable by every process on the machine (any user can list another process's argv), so a secret expanded into `command` would be public. An `env` map value is instead handed to `h1 open` in that process's environment, which the hosted program inherits.
- NAME must be a declared `vault` label. If the vault declares a `secrets` map, KEY must be one of its keys; if it does not, any KEY is allowed.
- References are late-bound: `check` and `plan` validate the name and key and print the reference as `${vault.NAME.KEY}`; they never fetch or expand it.

## Providers

| Provider | Status | Reference form (the `secrets` value; the KEY itself when unmapped) |
| --- | --- | --- |
| `dotenv` | available | The variable name in the file named by `path` (default `.env` beside the `.yah`). The file is `KEY=VALUE` lines, with `#` comments, optional `export ` prefixes and single- or double-quoted values. |
| `env` | available | The name of a variable in h1's process environment. |
| `command` | available | Passed to the `command` argv template as `{ref}` (`{key}` is the KEY). Any CLI that prints a secret to stdout can be a backend. |
| `1password` | available | An `op://vault/item/field` reference, read with the 1Password CLI (`op read`); `account` selects the account. |
| `bitwarden` | available | A Bitwarden item, read with `bw get`, in one of the forms `item` (its password), `item/username`, `item/password`, `item/notes`, `item/uri` or `item/totp`, or `item#custom` (a custom field). |
| `bitwarden-secrets` | available | A Bitwarden Secrets Manager secret id, read with `bws secret get`; the value is the `value` field of its JSON output. |
| `keychain` | available | A macOS Keychain service name, read with `security find-generic-password -w`; `account` distinguishes entries that share a service. |

All seven are adapters in this build, behind the same block and the same `${vault.NAME.KEY}` references, so a file changes backends by changing `provider` (and the reference forms in `secrets`), never by changing the places that use the secret.

## Security model

- **Fetched at `up`, only at `up`.** Every value a run needs is rendered before the first lab is opened. A secret that cannot be fetched, or that fetches as an empty value, stops the run with an error and **no lab is opened**.
- **Memory only.** Fetched values are held in memory for that run (and cached so a provider is not called twice for the same key). They are never written to disk by h1.
- **Environment, never argv.** A secret reaches the lab through the `h1 open` process environment, as described above, never as a command-line argument.
- **Scrubbed.** Known secret values are replaced with `***` in every message, error and provider output h1 prints. Errors name the vault, the key and the provider, never a value.
- **Names only in output.** `plan`, `graph`, `up --dry-run`, `runs`, `trace` and `vault status` print environment variable NAMES only — entries that come from a vault are marked as vault-sourced — and never print values.
- **Provider failures.** The CLI providers (`1password`, `bitwarden`, `bitwarden-secrets`, `keychain`) share one failure path: the error names the program and its exit status only, and never quotes the provider's stdout or stderr. A locked Bitwarden vault is reported as locked — `Bitwarden vault is locked: run: bw unlock` — instead of any provider output. The `command` provider's error likewise names its program and exit status; it may quote the first line of its stderr, scrubbed of any fetched values.
- **Never in manifests.** The run manifest records vault *names* and configuration only; no fetched value and no expanded `${env.*}` value ever appears in a manifest or any other run file.

## Switching backends with `--var`

Because a block ignores keys the selected provider does not use, the provider itself can come from a variable:

```yah check
yah 1

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
```

```sh
h1 up fleet.yah                            # dotenv: read fleet.env (the default)
h1 up fleet.yah --var secrets=env          # the same block, read the process environment
h1 up fleet.yah --var secrets=1password    # the same block, read with the 1Password CLI
```

This is the pattern `fleet.yah` uses: the graph, the harness `env` maps and the secret names stay identical; only the backend changes.

## `--env-file`

`${env.NAME}` lookups, and the tokens provider CLIs themselves need, can come from dotenv files as well as the real environment:

- `--env-file PATH` (repeatable) is accepted by `check`, `plan`, `graph` and `up`.
- Unless `--no-env-file` is passed, a `.env` file in the directory of the `.yah` file is used implicitly when it exists.
- Lookup order for `${env.NAME}`: the real process environment first, then the files, with an earlier `--env-file` winning over a later one.
- The same merged view is the bootstrap environment for provider CLIs: it is passed to them so a token such as `OP_SERVICE_ACCOUNT_TOKEN`, `BW_SESSION` or `BWS_ACCESS_TOKEN` can live in an env file instead of being exported in the shell.
- Values loaded from these files never appear in h1 output; they are passed only to the processes h1 opens and to the provider CLIs.

## Worked examples

### 1. A dotenv vault for local development

```yah check
yah 1

vault "local" {
  provider = "dotenv"
  path     = "fleet.env"
  secrets  = {
    FLEET_TOKEN = "FLEET_TOKEN"
  }
}

harness "worker" {
  kind  = "h1"
  role  = "worker"
  model = "system-one"
  open {
    command = ["cat"]
    env = {
      FLEET_TOKEN = "${vault.local.FLEET_TOKEN}"
    }
  }
}
```

With `FLEET_TOKEN=...` in `fleet.env` beside the `.yah` file, `h1 up` fetches it and the `worker` program sees it as `$FLEET_TOKEN`. The `.env` file itself is never committed.

### 2. One block, two backends

Example 1 with `provider = var.secrets` and a `variable "secrets"` defaulting to `"dotenv"` (the full form is in "Switching backends" above): locally the token comes from `fleet.env`; in CI, `--var secrets=env` reads the same name from the CI environment, where the CI system injects it. No other line changes.

### 3. AliasVault (not an h1 backend)

AliasVault cannot be read from h1. Its vault is end-to-end encrypted: no CLI or plain HTTP API returns a plaintext credential or creates an item, and the in-container `aliasvault` CLI is admin-only (`reset-admin-password`, `hash-password`). Decryption is client-side after unlock, so no `command` provider can fetch from it.

The only interop is the other direction: importing into AliasVault via its web UI, Settings -> Import / Export, Generic CSV with columns `service_name,url,username,password,totp_secret,notes,folder`.

## Prototypes, pools and decisions

- `prototype "label" { kind, role, model, open { ... } }`: a harness template. A `harness` with `prototype = "label"` inherits every key it leaves out; its `open` block merges key by key.
- `pool "label" { prototype, parent, min, max, idle_ttl, constraints }`: a conventional way to say "several workers". `min` members `label-1..` are expanded into harnesses and joined to every team rooted at `parent`; `max`, `idle_ttl` and `constraints` are recorded for the runtime.
- `decision "label" { pool, model, input, output, constraints }`: a named request type; a harness lists the ones it may use in `can_ask`.
- `defaults` also accepts `worktree_root`, `status_dir` and `target_dir` (strings; use `${var.*}` inside them).

See `yah/examples/rolepool.yah`.

# Graphloop architecture

How a `.yah` file becomes a running lab, and where each decision is made. Every claim here
names the code that implements it; if the code changes, this file changes in the same commit.

## The pipeline

```text
.yah source
  -> lexer      lexer::lex(file, src) -> Vec<Token>
  -> parser     parser::parse(file, src) -> Result<ast::File, Diagnostics>
  -> AST        ast::File { name, version, stmts } (Block / Assign / Expr)
  -> scope      scope::Scope::build(&file) -> Scope
  -> resolve    resolve::resolve(file, overrides, &scope) -> Result<ast::File, Diagnostics>
  -> schema     schema::build(&resolved, &scope) -> Result<Spec, Diagnostics>
  -> Spec       spec::Spec (typed blocks, spec::Templ strings)
  -> pick       pick::resolve_all(&spec, picker) -> Vec<pick::Resolved>
  -> plan       plan::build(&spec, team, &resolved, &opts) -> Result<Plan, Diagnostics>
  -> up         the CLI opens the labs in the Plan; only here are env/vault values fetched
                and spec::Templ rendered through spec::RenderCtx
```

`load::load_str` / `load::load_file` run the front end in exactly that order up to `Spec`:
`parser::parse` -> `Scope::build` -> `resolve::resolve` -> `schema::build`. Diagnostics from
an earlier pass are returned before any later pass runs.

## Binding stages

One definition lives in `refs.rs`: the `Reference` enum, `Reference::parse`, the `FORMS`
table and `valid_forms()`. `resolve` and `schema` both classify a dotted path through
`Reference::parse`; nothing else in the crate matches reference words as strings. Every
reference belongs to exactly one `refs::Stage` (`Reference::stage()`, and
`Stage::Compile < Stage::Plan < Stage::Apply`):

| Form | Stage | Bound when |
| --- | --- | --- |
| `var.<name>` | Compile | `resolve` folds the variable's default, or its `--var` override, into the AST |
| `harnesses.<label>.model` | Plan | After `pick` chooses a model: `provider/id` (`Resolved::display_model`) |
| `harnesses.<label>.model_id` | Plan | After `pick`: the bare model id, with the provider prefix stripped |
| `env.<NAME>` | Apply | Read from the process environment when a lab is opened, never earlier |
| `vault.<name>.<KEY>` | Apply | Fetched by `vault::Vaults::fetch` when a lab is opened, never earlier |

In the `Spec`, a not-yet-bound string is a `spec::Templ` (`Vec<Part>` with `Part::Lit`,
`Part::Env`, `Part::HarnessModel`, `Part::HarnessModelId`, `Part::Vault`).
`Templ::display()` prints late-bound parts as `${env.NAME}`, `${harnesses.NAME.model}` or
`${vault.NAME.KEY}` and never expands them; `Templ::render(&RenderCtx)` expands them, with
`RenderCtx { env, model, vault }` supplying the Apply- and Plan-stage values.

## What each pass may and may not do

- **Lexer** (`lexer::lex`): turns source text into tokens. It does not fail: a bad token
  (unexpected character, invalid number, unterminated string) becomes a `Tok::Error`
  diagnostic token and lexing continues, so later errors are still reported. It builds no
  tree and knows no block kinds or reference forms.
- **Parser** (`parser::parse`): builds the `ast::File` and reports each `Tok::Error`
  exactly once. It splits `${...}` interpolations in double-quoted strings into
  `StrPart::Interp` leaves. It does not resolve references, derive declared names, or
  validate block contents.
- **Scope build** (`scope::Scope::build`): the ONLY place declared names are derived from
  the AST: `Scope { variables, vaults, vault_keys, harnesses }`, in declaration order
  (`vault_keys` maps a vault label to its declared `secrets` keys; an empty list means any
  key is allowed). `resolve` and `schema` borrow the same `Scope`; neither re-derives
  these lists.
- **Resolve** (`resolve::resolve`): a `visit::Visitor` over the AST (the `Walker` in
  `resolve.rs`, recursing through `visit::walk_block` / `walk_assign` / `walk_expr`;
  string interpolations are leaves handled by `visit_expr`). It folds Compile-stage
  `var.*` references, and validates the other forms through `Reference::parse`. A
  variable default may not itself contain references. It does not bind Plan- or
  Apply-stage references, decode blocks, or execute anything.
- **Schema decode** (`schema::build`): turns the resolved AST into a typed `Spec`. It
  checks block kinds against `KNOWN_KINDS`, rejects unknown, duplicate and wrongly
  labelled blocks, dispatches each kind to its `parse_*` function (`parse_variable`,
  `parse_provider`, `parse_vault`, `parse_harness`, and so on), and finishes with
  cross-reference validation and defaults application. It does not resolve references:
  `var.*` is already folded, and Plan/Apply forms are carried into the `Spec` as `Templ`
  parts. A `vault.*` part is accepted only where the decoder enables it (env maps), so a
  secret can only ever travel through a program's environment, never its command line.
- **Pick** (`pick::resolve_all` with a `pick::Picker`, e.g. `SystemOnePicker`): chooses
  the concrete model for each harness and returns `Vec<Resolved>`. It binds no strings
  and opens nothing.
- **Plan** (`plan::build`, `plan::manifest`): turns a `Spec` plus the pick results into a
  `Plan` of open steps for one team. It renders nothing that needs a secret and fetches
  no vault value: per `vault.rs`, nothing is read at parse, check or plan time.
- **Up**: the only stage that executes. Vault values are fetched here, held in memory for
  the run, handed to programs through their environment, and scrubbed from printed output
  with `vault::scrub`. No earlier pass executes anything.

## Why this is a compiler, not an interpreter

A `.yah` file is declarative configuration, not a program: it declares blocks, values and
references, and contains no statements to evaluate and no user code to run. The front end
compiles it, in staged passes, to a typed `Spec`, and `pick` + `plan` lower that to a
`Plan`; execution, if it happens at all, is the separate `up` step consuming the plan.
Binding is staged for the same reason: a value is bound in the earliest stage that can
know it (Compile), and no earlier than the stage that must know it (vault secrets do not
exist in the process until Apply).

There is exactly one extension point for future expressions: `StrPart::Interp` in
`ast.rs` (see its S7 doc comment). An interpolation holding a reference path is the ONLY
expression form today. A future `Expr::Call` or conditional would be added there as a new
expression form, resolved by the same `resolve` pass; references stay the leaves.

## Recipes

### (a) Add a block kind

1. Add the kind string to `KNOWN_KINDS` in `schema.rs`, and to `SINGLETONS` or `LABELLED`
   there if it is a singleton or takes a label.
2. Add a `parse_<kind>` function in `schema.rs` and one dispatch arm for it in
   `schema::build`'s match.
3. Add the typed struct and its collection field on `spec::Spec` in `spec.rs`.
4. Only if other passes must know its declared label: add one arm to `Scope::build` in
   `scope.rs` (the only place labels are derived). Describe the block in
   `docs/graphspec.md`.

### (b) Add a reference form

1. Add a variant to `Reference` in `refs.rs`, one arm to `Reference::parse`, and the
   spelling to `FORMS` (`valid_forms()` is built from `FORMS`, so diagnostics update
   automatically).
2. Add its arms to `Reference::stage()` and `Reference::path()` in `refs.rs`.
3. Handle the variant where its stage is bound: classification in the `Walker` in
   `resolve.rs`, and, for a Plan/Apply form, a new `spec::Part` variant with its
   `Templ::display()` and `Templ::render()` arms in `spec.rs`.

### (c) Add a vault provider

1. Add one row to `PROVIDERS` in `vault.rs` (`ProviderInfo { name, keys, required,
   summary }`). `schema::parse_vault` validates vault blocks against this table via
   `vault::provider()` / `provider_names()`, so there is no second list to update.
2. Add one arm in `Vaults::fetch` in `vault.rs`, usually a `fetch_<name>` helper next to
   `fetch_dotenv` / `fetch_1password`; it returns the secret value and is only ever
   called at Apply time.
3. Only if the adapter needs a config key the `vault` block does not already carry
   (`path`, `account`, `command`, `secrets`): add the field to `spec::Vault` in `spec.rs`
   and read it in `schema::parse_vault`.

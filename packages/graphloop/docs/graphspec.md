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
- Interpolation: `${env.NAME}` `${var.name}` `${harnesses.builder.model}`
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
| `harness` | 0..n | named agent harnesses (kind = agent-cli-lab) |
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
  kind  = "agent-cli-lab"
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
  kind   = "agent-cli-lab"
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

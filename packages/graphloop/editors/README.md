# Graphspec (`.yah`) editor support

`yah.tmLanguage.json` is a TextMate grammar for Graphspec files (`scopeName: source.yah`, file type `yah`): `//` comments, the `yah 1` header, the eleven top-level block keywords plus `open`, labeled block strings, keys before `=`, double-quoted strings with `${...}` interpolation scoped separately (`env` / `var` / `harnesses` as `support.variable`), backtick raw strings, numbers, `true` / `false` / `null`, references such as `harnesses.builder.model`, and punctuation. `language-configuration.json` adds `//` comments, bracket matching and auto-closing pairs for editors that use it.

## VS Code (local extension)

1. Copy this `editors/` folder to `~/.vscode/extensions/graphspec-yah-0.1.0/` (on Windows: `%USERPROFILE%\.vscode\extensions\graphspec-yah-0.1.0\`).
2. Add a minimal `package.json` next to it:

```json
{
  "name": "graphspec-yah",
  "version": "0.1.0",
  "publisher": "graphloop",
  "engines": { "vscode": "^1.80.0" },
  "contributes": {
    "languages": [{ "id": "yah", "extensions": [".yah"], "configuration": "./language-configuration.json" }],
    "grammars": [{ "language": "yah", "scopeName": "source.yah", "path": "./yah.tmLanguage.json" }]
  }
}
```

3. Restart VS Code and open any `.yah` file; the language should show as Graphspec.

## Other editors

Any editor with TextMate grammar support (Sublime Text, TextMate, Atom-derived editors, and the `textmate` parsers used by many static site highlighters) can load `yah.tmLanguage.json` directly and map it to `*.yah`. Editors without TextMate support can still use `language-configuration.json`'s rules (`//` comments, `{ }` / `[ ]` brackets) as a starting point for a hand-written mode.

## Checking the grammar

`node check.mjs` (no dependencies, run from this directory) parses both JSON files, compiles every `match` / `begin` / `end` regex with `new RegExp(...)`, and sanity-tokenises the sample `.yah` files (the canonical fixture and `../examples/` when present): header, comment, block keyword, interpolation and reference patterns must each hit where expected.

## Next step: tree-sitter

A tree-sitter grammar is the planned next step: it would give structural highlighting, folding and selection that a regex grammar cannot, and it is what the vault's "Dedicated TextMate/tree-sitter grammar" line points at. No tree-sitter grammar exists yet — this TextMate grammar is the current, only grammar.

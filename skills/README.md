# Agent skills

This directory contains the `orchestrator-options` and `lab-commander` skill bundles. Install all discovered immediate child skills, or selected names, with:

```sh
python3 skills/install.py [skill ...] [--agent claude|codex|pi|all] [--home PATH]
```

Agent skills for Pi, Claude Code and Codex: the default install target is `all`, linking into each agent's skill directory. `--home` selects the home root (default: current user's home); use a temporary directory for tests. Discovery and source paths are relative to this installer, regardless of current working directory. Installation is idempotent for links already pointing to the source. Conflicting files, directories, or links are reported and never overwritten; any conflict returns nonzero. Executable files directly inside a skill's `bin/` are linked into `<home>/.local/bin` for every selected skill.

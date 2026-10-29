# Skills collection

This directory contains the agent-neutral skill bundles `bourbon-devbox`, `orchestrator-options`, and `lab-commander`. Install all discovered immediate child skills, or selected names, with:

```sh
python3 packages/skills/install.py [skill ...] [--agent claude|codex|pi|all] [--home PATH]
```

The default agent is `all`: Claude, Codex, and Pi skill directories. `--home` selects the home root (default: current user's home); use a temporary directory for tests. Discovery and source paths are relative to this installer, regardless of current working directory. Installation is idempotent for links already pointing to the source. Conflicting files, directories, or links are reported and never overwritten; any conflict returns nonzero. Executable files directly inside a skill's `bin/` are linked into `<home>/.local/bin` for every selected skill.

#!/bin/sh
# Link lab-commander into Claude Code, Codex and Pi, and put labctl on PATH.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
for dir in "$HOME/.claude/skills" "$HOME/.codex/skills" "$HOME/.pi/agent/skills"; do
  mkdir -p "$dir"; ln -sfn "$here" "$dir/lab-commander"; echo "linked $dir/lab-commander"
done
mkdir -p "$HOME/.local/bin"; ln -sfn "$here/bin/labctl" "$HOME/.local/bin/labctl"; echo "linked ~/.local/bin/labctl"
command -v agent-cli-lab >/dev/null || echo "warning: agent-cli-lab not on PATH"

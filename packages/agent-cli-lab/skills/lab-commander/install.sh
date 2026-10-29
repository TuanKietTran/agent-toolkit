#!/bin/sh
# Build/install the package CLI, then link this skill and its helper commands.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
package_dir=$(cd "$here/../../.." && pwd)
cargo install --locked --path "$package_dir"
agent-cli-lab --version
for dir in "$HOME/.claude/skills" "$HOME/.codex/skills" "$HOME/.pi/agent/skills"; do
  mkdir -p "$dir"
  ln -sfn "$here" "$dir/lab-commander"
  echo "linked $dir/lab-commander"
done
mkdir -p "$HOME/.local/bin"
for helper in labctl lab-clean lab-watch; do
  ln -sfn "$here/bin/$helper" "$HOME/.local/bin/$helper"
  echo "linked ~/.local/bin/$helper"
done

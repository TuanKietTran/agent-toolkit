#!/bin/sh
# Install package CLI and skill links without overwriting real destinations.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
package_dir=$(cd "$here/../.." && pwd)
root=${INSTALL_ROOT:-"$HOME/.local"}
cargo install --locked --path "$package_dir" --root "$root" --force
PATH="$root/bin:$PATH"
export PATH
printf 'agent-cli-lab: %s\n' "$(command -v agent-cli-lab)"
agent-cli-lab --version
if ! agent-cli-lab open --help >/dev/null 2>&1; then
  echo "agent-cli-lab on PATH lacks open; upgrade/install failed" >&2
  exit 1
fi
link_safe() {
  source=$1 dest=$2
  if [ -e "$dest" ] && [ ! -L "$dest" ]; then
    echo "skipping existing real file/directory: $dest" >&2
    return
  fi
  ln -sfn "$source" "$dest"
  echo "linked $dest"
}
for dir in "$HOME/.claude/skills" "$HOME/.codex/skills" "$HOME/.pi/agent/skills"; do
  mkdir -p "$dir"
  link_safe "$here" "$dir/lab-commander"
done
mkdir -p "$root/bin"
for helper in labctl lab-clean lab-watch; do
  link_safe "$here/bin/$helper" "$root/bin/$helper"
done

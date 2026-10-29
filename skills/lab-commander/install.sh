#!/bin/sh
# Install the agent-cli-lab binary, then delegate skill linking to the shared installer.
set -e
SKILL_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
cargo install --locked --path "$SKILL_DIR/../../packages/agent-cli-lab"
python3 "$SKILL_DIR/../install.py" lab-commander "$@"

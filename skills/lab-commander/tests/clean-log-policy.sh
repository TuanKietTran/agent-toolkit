#!/bin/sh
# Verify default cleanup removes only the named host log, retaining recording.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
root=$(mktemp -d "${TMPDIR:-/tmp}/lab-clean-logs.XXXXXX")
trap 'rm -rf "$root"' EXIT HUP INT TERM
mkdir -p "$root/bin" "$root/workspace/logs"
printf '#!/bin/sh\ncase "$1" in open) exit 1;; send|ls) exit 0;; *) exit 0;; esac\n' > "$root/bin/agent-cli-lab"
chmod +x "$root/bin/agent-cli-lab"
printf host > "$root/workspace/logs/worker.host.log"
printf recording > "$root/workspace/logs/worker.jsonl"
PATH="$root/bin:$PATH" "$here/../bin/lab-clean" worker --workspace "$root/workspace" >/dev/null
[ ! -e "$root/workspace/logs/worker.host.log" ]
[ -f "$root/workspace/logs/worker.jsonl" ]
[ "$(cat "$root/workspace/logs/worker.jsonl")" = recording ]

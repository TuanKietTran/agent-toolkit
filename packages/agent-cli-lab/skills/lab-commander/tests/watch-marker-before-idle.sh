#!/bin/sh
# Regression: a marker appended after watcher baseline must win over idle.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
root=$(mktemp -d "${TMPDIR:-/tmp}/lab-watch-marker.XXXXXX")
trap 'kill "${watch_pid:-}" 2>/dev/null || true; rm -rf "$root"' EXIT HUP INT TERM
mkdir -p "$root/bin"
printf '#!/bin/sh\ncase "$1" in open) exit 1;; screen) printf "quiet screen\\n";; *) exit 2;; esac\n' > "$root/bin/agent-cli-lab"
chmod +x "$root/bin/agent-cli-lab"
PATH="$root/bin:$PATH" "$here/../bin/lab-watch" regression 15 --status "$root/status" >"$root/result" &
watch_pid=$!
sleep 2.2 # allow at least one 2-second poll to establish the baseline
printf 'LAB-CHECKPOINT fresh-marker\n' > "$root/status"
wait "$watch_pid"
watch_pid=
grep -Fx 'LAB-CHECKPOINT fresh-marker' "$root/result"
! grep -q '^WATCH-IDLE ' "$root/result"

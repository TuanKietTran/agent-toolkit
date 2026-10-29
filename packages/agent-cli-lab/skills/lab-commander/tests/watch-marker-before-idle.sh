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

# Rendered screens can echo an old marker repeatedly. Only a different, new
# line-start marker should fire after the watcher's screen baseline.
mkdir -p "$root/echo-bin"
printf '#!/bin/sh\ncase "$1" in open) exit 1;; screen) n=0; [ ! -f "$COUNT_FILE" ] || n=$(cat "$COUNT_FILE"); n=$((n+1)); printf "%s\\n" "$n" > "$COUNT_FILE"; if [ "$n" -eq 1 ]; then printf "LAB-CHECKPOINT old-marker\\n"; else printf "LAB-CHECKPOINT old-marker\\nLAB-CHECKPOINT old-marker\\nLAB-CHECKPOINT new-marker\\nLAB-CHECKPOINT new-marker\\n"; fi;; *) exit 2;; esac\n' > "$root/echo-bin/agent-cli-lab"
chmod +x "$root/echo-bin/agent-cli-lab"
COUNT_FILE="$root/count" PATH="$root/echo-bin:$PATH" "$here/../bin/lab-watch" regression-echo 15 >"$root/echo-result" &
watch_pid=$!
sleep 2.2
wait "$watch_pid"
watch_pid=
grep -Fx 'LAB-CHECKPOINT new-marker' "$root/echo-result"
! grep -q 'old-marker' "$root/echo-result"
! grep -q '^WATCH-IDLE ' "$root/echo-result"

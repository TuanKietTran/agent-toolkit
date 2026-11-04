#!/bin/sh
# Regression coverage for newly observed watcher events.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
root=$(mktemp -d "${TMPDIR:-/tmp}/lab-watch-marker.XXXXXX")
trap 'kill "${watch_pid:-}" 2>/dev/null || true; rm -rf "$root"' EXIT HUP INT TERM
mkdir -p "$root/bin"
cat >"$root/bin/agent-cli-lab" <<'FAKE'
#!/bin/sh
case "$1" in
  open) exit 1 ;;
  screen)
    n=0; [ ! -f "$COUNT_FILE" ] || n=$(cat "$COUNT_FILE"); n=$((n+1)); printf '%s\n' "$n" > "$COUNT_FILE"
    case "$MODE:$n" in
      status:*) printf 'quiet screen\n' ;;
      w2:1) printf 'LAB-CHECKPOINT old-marker\n' ;;
      w2:*) printf 'LAB-CHECKPOINT old-marker\nLAB-CHECKPOINT old-marker\nLAB-CHECKPOINT new-marker\nLAB-CHECKPOINT new-marker\n' ;;
      w2b:1) printf 'LAB-BLOCKED x\nusage limit\n' ;;
      w2b:*) printf 'quiet screen\n' ;;
      w2c:1) printf 'LAB-CHECKPOINT old-marker\n' ;;
      w2c:*) printf 'screen filled\nLAB-CHECKPOINT new-marker\n' ;;
      gone) exit 1 ;;
    esac ;;
  *) exit 2 ;;
esac
FAKE
chmod +x "$root/bin/agent-cli-lab"
run_watch() {
  scenario=$1; seconds=$2; shift 2
  rm -f "$root/count"
  MODE="$scenario" COUNT_FILE="$root/count" PATH="$root/bin:$PATH" "$here/../bin/lab-watch" "$scenario" "$seconds" "$@"
}
# --status mode: baseline the old line, then emit the new line only.
printf 'LAB-CHECKPOINT old-status\n' > "$root/status"
MODE=status COUNT_FILE="$root/count" PATH="$root/bin:$PATH" "$here/../bin/lab-watch" status 15 --status "$root/status" >"$root/status.out" &
watch_pid=$!
sleep 1
printf 'LAB-CHECKPOINT fresh-marker\n' >> "$root/status"
wait "$watch_pid"; watch_pid=
[ "$(cat "$root/status.out")" = 'LAB-CHECKPOINT fresh-marker' ]
# W2: old marker baseline; exactly one new marker line is emitted.
run_watch w2 10 >"$root/w2.out" & watch_pid=$!
sleep 2.2
wait "$watch_pid"; watch_pid=
[ "$(cat "$root/w2.out")" = 'LAB-CHECKPOINT new-marker' ]
# W2b: stale blocker/limit lines are baseline, not immediate events.
run_watch w2b 10 >"$root/w2b.out"
grep -Fx 'WATCH-IDLE w2b' "$root/w2b.out"
# W2c: old marker scrolls off as a new marker arrives.
run_watch w2c 10 >"$root/w2c.out" & watch_pid=$!
sleep 2.2
wait "$watch_pid"; watch_pid=
[ "$(cat "$root/w2c.out")" = 'LAB-CHECKPOINT new-marker' ]

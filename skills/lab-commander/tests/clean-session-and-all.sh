#!/bin/sh
# Cover session-dir encoding and depth-limited --all discovery.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
root=$(mktemp -d "${TMPDIR:-/tmp}/lab-clean-session.XXXXXX")
trap 'rm -rf "$root"' EXIT HUP INT TERM
mkdir -p "$root/bin" "$root/workspace/status" "$root/workspace/logs/handoffs" "$root/home/.pi/agent/sessions/--tmp-x-y--"
cat >"$root/bin/agent-cli-lab" <<'FAKE'
#!/bin/sh
case "$1" in
  open) exit 1 ;;
  send) printf '%s\n' "$3" >> "$CALLS"; exit 0 ;;
  ls) exit 0 ;;
  *) exit 0 ;;
esac
FAKE
chmod +x "$root/bin/agent-cli-lab"
printf handoff > "$root/home/.pi/agent/sessions/--tmp-x-y--/handoff.json"
: > "$root/calls"
HOME="$root/home" PATH="$root/bin:$PATH" CALLS="$root/calls" "$here/../bin/lab-clean" a --workspace "$root/workspace" --cwd /tmp/x/y >/dev/null
[ ! -e "$root/home/.pi/agent/sessions/--tmp-x-y--/handoff.json" ]
set -- "$root"/workspace/logs/handoffs/a-*.json
[ -f "$1" ]
printf a > "$root/workspace/status/a.log"
printf b > "$root/workspace/logs/b.host.log"
printf old > "$root/workspace/logs/handoffs/old-1.json"
: > "$root/calls"
HOME="$root/home" PATH="$root/bin:$PATH" CALLS="$root/calls" "$here/../bin/lab-clean" --all --workspace "$root/workspace" >/dev/null
[ "$(sort -u "$root/calls")" = "$(printf '%s\n' a b)" ]
[ -f "$root/workspace/logs/handoffs/old-1.json" ]

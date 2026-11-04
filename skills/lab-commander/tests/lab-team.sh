#!/bin/sh
# lab-team opens builder/explorer/advisor with the right models, roles and parent links.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
root=$(mktemp -d "${TMPDIR:-/tmp}/lab-team.XXXXXX")
trap 'rm -rf "$root"' EXIT HUP INT TERM
mkdir -p "$root/bin"
cat > "$root/bin/agent-cli-lab" <<'FAKE'
#!/bin/sh
printf '%s\n' "$*" >> "$LAB_TEAM_CALLS"
FAKE
chmod +x "$root/bin/agent-cli-lab"
export LAB_TEAM_CALLS="$root/calls"
: > "$LAB_TEAM_CALLS"

PATH="$root/bin:$PATH" "$here/../bin/lab-team" up -p t1 --parent cmdr --cwd /work/repo
[ "$(wc -l < "$LAB_TEAM_CALLS")" -eq 3 ]
grep -q '^open -n t1-builder --role builder --model claude-cli/claude-sonnet-5-5 --cwd /work/repo --parent cmdr -- env -u ' "$LAB_TEAM_CALLS"
grep -q '^open -n t1-explorer --role explorer --model claude-cli/claude-haiku-5-5 --cwd /work/repo --parent t1-builder -- env ' "$LAB_TEAM_CALLS"
grep -q '^open -n t1-advisor --role advisor --model claude-cli/claude-opus-5-5 --cwd /work/repo --parent t1-builder -- env ' "$LAB_TEAM_CALLS"
# nested Claude Code variables are removed for every lab, and the provider line is exact
[ "$(grep -c -- '-u CLAUDE_CODE_ENTRYPOINT .* -u CLAUDECODE .*pi --provider claude-cli --model claude-.* --no-session$' "$LAB_TEAM_CALLS")" -eq 3 ]

# only a subset: explorer and advisor under an existing builder are not guessed, they hang under --parent
: > "$LAB_TEAM_CALLS"
PATH="$root/bin:$PATH" "$here/../bin/lab-team" up -p t2 --parent lead --only explorer
[ "$(wc -l < "$LAB_TEAM_CALLS")" -eq 1 ]
grep -q '^open -n t2-explorer --role explorer .* --parent lead -- env ' "$LAB_TEAM_CALLS"

# extra open arguments (headless hosting)
: > "$LAB_TEAM_CALLS"
LAB_TEAM_OPEN_ARGS=--detached PATH="$root/bin:$PATH" "$here/../bin/lab-team" up -p t4 --only advisor
grep -q '^open -n t4-advisor --role advisor --model claude-cli/claude-opus-5-5 --cwd .* --detached .*-- env ' "$LAB_TEAM_CALLS"

# plan prints and does not call the CLI
: > "$LAB_TEAM_CALLS"
out=$(PATH="$root/bin:$PATH" "$here/../bin/lab-team" plan -p t3)
[ ! -s "$LAB_TEAM_CALLS" ]
printf '%s\n' "$out" | grep -q 't3-builder'

# down stops helpers before the builder
: > "$LAB_TEAM_CALLS"
PATH="$root/bin:$PATH" "$here/../bin/lab-team" down -p t1
[ "$(sed -n 1p "$LAB_TEAM_CALLS")" = "stop -n t1-advisor" ]
[ "$(sed -n 3p "$LAB_TEAM_CALLS")" = "stop -n t1-builder" ]

# bad input is refused without calling anything
: > "$LAB_TEAM_CALLS"
if PATH="$root/bin:$PATH" "$here/../bin/lab-team" up -p 'bad name' 2>/dev/null; then exit 1; fi
if PATH="$root/bin:$PATH" "$here/../bin/lab-team" up -p ok --only wizard 2>/dev/null; then exit 1; fi
if PATH="$root/bin:$PATH" "$here/../bin/lab-team" up -p -x 2>/dev/null; then exit 1; fi
if PATH="$root/bin:$PATH" "$here/../bin/lab-team" up -p .hidden 2>/dev/null; then exit 1; fi
if PATH="$root/bin:$PATH" "$here/../bin/lab-team" up -p aaaaaaaaaabbbbbbbbbbccccccccccd 2>/dev/null; then exit 1; fi
[ ! -s "$LAB_TEAM_CALLS" ]
echo ok

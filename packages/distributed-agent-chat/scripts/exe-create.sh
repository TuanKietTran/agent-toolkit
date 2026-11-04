#!/bin/sh
# Opt-in only; creates two billable exe.dev sandboxes. Never run by tests/build.
set -eu
[ "${CONFIRM_EXE_CREATE:-NO}" = YES ] || { printf '%s\n' 'Disabled: creation requires CONFIRM_EXE_CREATE=YES.' >&2; exit 1; }
A=${EXE_NODE_A:-chat-a}
B=${EXE_NODE_B:-chat-b}
case "$A:$B" in *[!a-z0-9:-]*) printf '%s\n' 'Use lowercase VM names.' >&2; exit 1;; esac
[ "$A" != "$B" ] || exit 1
ssh exe.dev new --sandbox --name="$A"
ssh exe.dev new --sandbox --name="$B"
printf '%s\n' 'VMs created; no application, credentials, bucket or overlay was installed.'

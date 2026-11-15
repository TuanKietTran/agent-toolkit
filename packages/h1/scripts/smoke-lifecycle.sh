#!/bin/bash
# Smoke harness for the h1 lifecycle commands (reap and guard).
# Usage: smoke-lifecycle.sh [smoke-log]
#   smoke-log defaults to status/smoke.log relative to the directory
#   it is run from. Every command and its output are tee-ed there.
#   Needs a working pi agent CLI. Exits 2 when reap or guard are not
#   built yet, 1 when a smoke step fails, 0 when every step passes.
#   The reap step uses --ttl 10s so it does not wait 10 minutes.
set -u
LOG=${1:-status/smoke.log}
case $LOG in
/*)
  ;;
*)
  LOG=$PWD/$LOG
  ;;
esac
mkdir -p $(dirname $LOG)
: > $LOG
echo 'smoke-lifecycle: log follows in' $LOG | tee -a $LOG
cd $(dirname $0)/..
cargo build 2>&1 | tee -a $LOG
[ ${PIPESTATUS[0]} -eq 0 ] || { echo 'smoke-lifecycle: FAIL cargo build failed' | tee -a $LOG; exit 1; }
H1=$(ls target/debug/h1 ../../target/debug/h1 2>/dev/null | head -1)
[ -n $H1 ] || { echo 'smoke-lifecycle: FAIL h1 binary not found after build' | tee -a $LOG; exit 1; }
# run() joins args with $* and re-splits them, so only single-word args are safe here;
# the step 1 send (multi-word text) is called directly instead.
run() {
  echo '+ ' $* | tee -a $LOG
  $* 2>&1 | tee -a $LOG
  return ${PIPESTATUS[0]}
}
missing=
$H1 reap --help >/dev/null 2>&1 || missing='reap'
$H1 guard --help >/dev/null 2>&1 || missing=$missing' guard'
if [[ -n $missing ]]; then
  echo 'smoke-lifecycle: BLOCKED waiting for A/B, missing commands:' $missing | tee -a $LOG
  exit 2
fi
TMP=$(mktemp -d)
export H1_DIR=$TMP/h1
mkdir -p $H1_DIR
RUN=smoke-lifecycle
FAILS=0
trap '$H1 stop -n $RUN-done >/dev/null 2>&1; $H1 stop -n $RUN-failed >/dev/null 2>&1; rm -rf $TMP' EXIT
echo '--- step 1: reap parks a DONE idle agent ---' | tee -a $LOG
run $H1 open --detached -n $RUN-done -- pi --no-session
echo '+ ' $H1 send -n $RUN-done -e 'Reply with DONE and then stop.' | tee -a $LOG
$H1 send -n $RUN-done -e 'Reply with DONE and then stop.' 2>&1 | tee -a $LOG
i=0
while [ $i -lt 12 ]; do
  if $H1 screen -n $RUN-done 2>/dev/null | grep -q DONE; then break; fi
  sleep 5
  i=$((i+1))
done
run $H1 reap --run $RUN --ttl 10s || FAILS=$((FAILS+1))
if $H1 list 2>/dev/null | grep -q $RUN-done; then echo 'step 1: FAIL done lab still listed' | tee -a $LOG; FAILS=$((FAILS+1)); else echo 'step 1: PASS done lab parked' | tee -a $LOG; fi
echo '--- step 2: guard re-arms a failed agent ---' | tee -a $LOG
run $H1 open --detached -n $RUN-failed -- pi --no-session
pid=$($H1 status -n $RUN-failed --json 2>/dev/null | grep -o 'pid.:[0-9]*' | tr -dc '0-9' | head -1)
if [ -n $pid ]; then kill $pid; else echo 'step 2: NOTE no pid in status, skipping kill' | tee -a $LOG; fi
sleep 2
run $H1 guard --run $RUN --once
if $H1 status -n $RUN-failed >/dev/null 2>&1; then echo 'step 2: PASS failed lab working again' | tee -a $LOG; else echo 'step 2: FAIL failed lab not working' | tee -a $LOG; FAILS=$((FAILS+1)); fi
echo 'smoke-lifecycle: FAILS=' $FAILS | tee -a $LOG
[ $FAILS -eq 0 ] && exit 0 || exit 1

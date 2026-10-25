#!/usr/bin/env bash
# Smoke test for nexus-close-window, run under `xvfb-run -a`:
#   1. start xterm with XODUS_NEXUS_LAUNCH_ID=test123 in its environment
#      (xterm publishes _NET_WM_PID and exits on WM_DELETE_WINDOW),
#   2. --dry-run must match without closing anything,
#   3. --launch-id other must exit 1,
#   4. the real run must exit 0 and xterm must be gone within 5 s.
set -euo pipefail

bin=${1:?usage: nexus-close-window-smoke.sh <path-to-nexus-close-window>}
[[ -n "${DISPLAY:-}" ]] || { echo "DISPLAY is not set; run under xvfb-run"; exit 2; }

XODUS_NEXUS_LAUNCH_ID=test123 xterm -e sleep 300 &
xterm_pid=$!
trap 'kill "$xterm_pid" 2>/dev/null || true' EXIT

rc=0
"$bin" --launch-id test123 --timeout-ms 5000 --dry-run > dry-run.log || rc=$?
cat dry-run.log
[[ $rc -eq 0 ]] || { echo "dry-run: expected exit 0, got $rc"; exit 1; }
grep -Eq "^match 0x[0-9a-f]+ pid $xterm_pid\$" dry-run.log || { echo "dry-run: no match line for pid $xterm_pid"; exit 1; }
kill -0 "$xterm_pid" || { echo "dry-run closed the window"; exit 1; }

rc=0
"$bin" --launch-id other > other.log || rc=$?
cat other.log
[[ $rc -eq 1 ]] || { echo "other id: expected exit 1, got $rc"; exit 1; }
[[ ! -s other.log ]] || { echo "other id: unexpected output"; exit 1; }

rc=0
"$bin" --launch-id test123 --timeout-ms 5000 > close.log || rc=$?
cat close.log
[[ $rc -eq 0 ]] || { echo "close: expected exit 0, got $rc"; exit 1; }
grep -Eq "^closed 0x[0-9a-f]+ pid $xterm_pid\$" close.log || { echo "close: no closed line for pid $xterm_pid"; exit 1; }

for _ in $(seq 50); do
  kill -0 "$xterm_pid" 2>/dev/null || break
  sleep 0.1
done
if kill -0 "$xterm_pid" 2>/dev/null; then
  echo "xterm (pid $xterm_pid) is still running 5 s after WM_DELETE_WINDOW"
  exit 1
fi
wait "$xterm_pid" || true
trap - EXIT

rc=0
"$bin" --launch-id test123 > gone.log || rc=$?
[[ $rc -eq 1 ]] || { echo "after close: expected exit 1, got $rc"; exit 1; }

rc=0
DISPLAY=:99999 "$bin" --launch-id test123 2> nodisplay.log || rc=$?
[[ $rc -eq 2 ]] || { echo "no display: expected exit 2, got $rc"; exit 1; }
grep -q "cannot open X display" nodisplay.log

echo "nexus-close-window smoke test passed"

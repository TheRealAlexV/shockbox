#!/bin/bash
# Kill headless Chrome browsers and shockbox test servers that were orphaned (reparented to PID 1)
# or whose launching test script has gone. Safe by construction:
#   · only matches processes whose cmdline carries --headless
#   · refuses any whose binary lives under ~/.agent-browser (live agent-browser sessions)
#   · kills only top-level browser roots and lets the kernel reap the child tree
# Run: bash gui/sweep-orphans.sh [--dry-run]
set -u

DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1

kill_one() {
  if [ "$DRY" = "1" ]; then echo "would kill $1  $2"; else kill -9 "$1" 2>/dev/null; fi
}

browsers=0
for p in $(pgrep -x chrome 2>/dev/null); do
  args=$(tr '\0' ' ' < "/proc/$p/cmdline" 2>/dev/null) || continue
  case "$args" in
    *--headless*) ;;
    *) continue ;;
  esac
  exe=$(readlink "/proc/$p/exe" 2>/dev/null)
  case "$exe" in
    */agent-browser/*) continue ;;
  esac
  ppid=$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' ')
  # A browser root: its parent is not another chrome process, and it is orphaned.
  case "$ppid" in
    1|"") kill_one "$p" "orphan headless browser"; browsers=$((browsers+1)) ;;
  esac
done

servers=0
for p in $(pgrep -f 'node .*shockbox/server\.mjs --port' 2>/dev/null); do
  ppid=$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' ')
  if [ "$ppid" = "1" ]; then
    kill_one "$p" "orphan shockbox test server"
    servers=$((servers+1))
  fi
done

echo "headless browsers swept: $browsers   test servers swept: $servers"

#!/bin/bash
# Reap headless Chrome browsers that nothing is looking after, plus orphaned shockbox test servers.
#
# Run by the shockbox-sweep-orphans.timer user unit every 3 minutes; also safe to run by hand.
# Run: bash gui/sweep-orphans.sh [--dry-run]
#   no argument = apply (this is what the timer runs)
#
# Why it is not just "ppid == 1" any more: `nohup setsid google-chrome --headless=new ...` from a
# throwaway shell reparents to whatever is still alive (a tmux server, an agent session), so an
# orphan check on PID 1 saw nothing while eight SwiftShader browsers cooked the box to 97 °C.
# So the rule is now ownership, not parentage.
#
# What it matches: a *root* browser process (parent is not itself a browser) whose cmdline carries
# --headless. Child renderer/gpu/zygote processes are left alone: killing the root takes the tree.
#
# What it never touches:
#   · anything whose /proc/<pid>/exe resolves under ~/.agent-browser (live agent-browser sessions)
#   · a browser whose direct parent is alive and is chrome-devtools-mcp / mcp-server-chrome
#   · a browser whose direct parent is alive and is node|bun|deno started from a test/ directory
#     (a live gate owns it)
#   · a browser younger than MIN_AGE seconds (120) — launch grace period
#   · a browser whose cmdline contains the marker `shockbox-sweep-skip` (manual opt-out)
#   · Brave, Edge, obs64, krisp, ccc, llama-server, opencode: different process names, never matched
set -u

DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1

MIN_AGE=120
HZ=$(getconf CLK_TCK 2>/dev/null || echo 100)
NOW=$(cut -d. -f1 /proc/uptime)

kill_one() {
  if [ "$DRY" = "1" ]; then echo "would kill $1  $2"; else kill -9 "$1" 2>/dev/null; fi
}

cmdline() { tr '\0' ' ' < "/proc/$1/cmdline" 2>/dev/null; }

# Seconds since the process started, 0 if it vanished.
age_of() {
  local st
  st=$(cut -d' ' -f22 "/proc/$1/stat" 2>/dev/null) || { echo 0; return; }
  [ -n "$st" ] || { echo 0; return; }
  echo $(( NOW - st / HZ ))
}

is_browser() {
  case "$(cat "/proc/$1/comm" 2>/dev/null)" in
    chrome|google-chrome|google-chrome-stable|chromium|chromium-browser|headless_shell) return 0 ;;
  esac
  return 1
}

# True when the given pid is an owner a headless browser is allowed to belong to.
# Matched on cmdline, not comm: node renames its comm to MainThread, so /proc/<pid>/comm says
# nothing about what a process is.
protected_owner() {
  local pid=$1 args cwd
  [ -d "/proc/$pid" ] || return 1
  args=$(cmdline "$pid")
  case "$args" in
    *chrome-devtools-mcp*|*mcp-server-chrome*|*chrome-mcp*) return 0 ;;
  esac
  # A live gate: node/bun/deno running a script out of a test/ directory.
  case "$args" in
    *node*test/*|*bun*test/*|*deno*test/*|*node*/test/*|*bun*/test/*) return 0 ;;
  esac
  cwd=$(readlink "/proc/$pid/cwd" 2>/dev/null)
  case "$cwd" in
    */test|*/test/*)
      case "$args" in
        *node*|*bun*|*deno*) return 0 ;;
      esac
      ;;
  esac
  return 1
}

browsers=0
skipped=0
for p in $(pgrep -x chrome 2>/dev/null) \
         $(pgrep -x google-chrome 2>/dev/null) \
         $(pgrep -x google-chrome-stable 2>/dev/null) \
         $(pgrep -x chromium 2>/dev/null) \
         $(pgrep -x chromium-browser 2>/dev/null) \
         $(pgrep -x headless_shell 2>/dev/null); do
  [ -d "/proc/$p" ] || continue
  args=$(cmdline "$p")
  case "$args" in
    *--headless*) ;;
    *) continue ;;
  esac
  case "$args" in
    *shockbox-sweep-skip*) skipped=$((skipped+1)); continue ;;
  esac
  exe=$(readlink "/proc/$p/exe" 2>/dev/null)
  case "$exe" in
    */agent-browser/*) skipped=$((skipped+1)); continue ;;
  esac
  ppid=$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' ')
  # Root only: a browser whose parent is another browser is part of a tree we do not split.
  case "$ppid" in
    ""|0) ;;
    *) is_browser "$ppid" && continue ;;
  esac
  # Launch grace period: a gate gets 120 s to prove it owns the browser.
  if [ "$(age_of "$p")" -lt "$MIN_AGE" ]; then
    skipped=$((skipped+1)); continue
  fi
  # Live owner: the gate or the MCP server that started it.
  case "$ppid" in
    ""|0|1) ;;
    *) protected_owner "$ppid" && { skipped=$((skipped+1)); continue; } ;;
  esac
  kill_one "$p" "unowned headless browser"
  browsers=$((browsers+1))
done

servers=0
for p in $(pgrep -f 'node .*shockbox/server\.mjs --port' 2>/dev/null); do
  ppid=$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' ')
  if [ "$ppid" = "1" ] && [ "$(age_of "$p")" -ge "$MIN_AGE" ]; then
    kill_one "$p" "orphan shockbox test server"
    servers=$((servers+1))
  fi
done

echo "$(date '+%F %T')  headless browsers swept: $browsers   test servers swept: $servers   kept (owner/grace/marker): $skipped"

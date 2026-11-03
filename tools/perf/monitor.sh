#!/usr/bin/env bash
# ShockBox perf monitor: runs the 5 s sampler until killed. Installed as
# shockbox-perf-monitor.service (systemd --user), which is the only always-on load
# this tooling adds besides LibreHardwareMonitor itself.
set -euo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

# systemd --user has no nvm in PATH; fall back to the newest nvm node.
node_bin=$(command -v node || true)
if [ -z "$node_bin" ]; then
  node_bin=$(ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V | tail -1 || true)
fi
if [ -z "$node_bin" ] || [ ! -x "$node_bin" ]; then
  echo "monitor.sh: no node found (looked in PATH and \$HOME/.nvm/versions/node/*/bin/node)" >&2
  exit 127
fi

exec "$node_bin" "$here/sample.mjs" --watch

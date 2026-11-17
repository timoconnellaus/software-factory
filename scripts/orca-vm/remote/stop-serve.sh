#!/usr/bin/env bash
# Runs INSIDE the sprite. Stops the running orca serve. `orca-ide serve` hands off to a detached
# orcad process and the launcher exits, so its pid is useless: the live server's pid is in orcad's
# instance lock. The terminal daemon (orcad's child) keeps running, so terminals survive a
# suspend/resume, as they do across a desktop restart.
set -euo pipefail

data_root="${ORCA_USER_DATA_PATH:-${XDG_CONFIG_HOME:-$HOME/.config}/orca}"
lock="$data_root/orcad.lock"
[ -f "$lock" ] || exit 0
pid="$(node -e 'try{const l=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8"));if(l.role==="orcad"&&Number.isInteger(l.pid))process.stdout.write(String(l.pid))}catch{}' "$lock" 2>/dev/null || true)"
[ -n "$pid" ] || exit 0
kill -0 "$pid" 2>/dev/null || exit 0
# Only signal a process that is really our orca server, never a recycled pid.
case "$(readlink "/proc/$pid/exe" 2>/dev/null || true)" in
  "$HOME"/.local/opt/orca-server-*) ;;
  *) echo "pid $pid in $lock is not an orca server process; not stopping it" >&2; exit 0 ;;
esac
kill -TERM "$pid"
for _ in $(seq 1 80); do kill -0 "$pid" 2>/dev/null || exit 0; sleep 0.25; done
echo "orca serve (pid $pid) did not stop after 20s; killing it" >&2
kill -KILL "$pid" 2>/dev/null || true

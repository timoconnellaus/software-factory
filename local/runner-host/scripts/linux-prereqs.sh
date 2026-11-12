#!/bin/sh
# Checks a Linux box for what the runner needs (spec 34, ADR 0420) and prints what is missing:
# Node ≥ 24, git, tmux ≥ 3.2, bubblewrap and socat (Claude Code's sandbox), Claude Code, systemd
# for the user, and linger.
#
#   local/runner-host/scripts/linux-prereqs.sh             # check only, changes nothing
#   local/runner-host/scripts/linux-prereqs.sh --install   # also runs, with sudo, exactly:
#       sudo apt-get update && sudo apt-get install -y git tmux bubblewrap socat
#
# It never installs Node or Claude Code (see the runner-host README), never pipes anything from the
# internet into a shell, and never turns on linger for you (it prints the command).
set -u
install=0
[ "${1:-}" = "--install" ] && install=1
missing=""
problems=0

have() { command -v "$1" >/dev/null 2>&1; }
ok() { echo "ok   $1"; }
bad() {
  echo "MISS $1"
  problems=$((problems + 1))
}
warn() { echo "warn $1"; }

if [ "$install" = 1 ]; then
  if ! have apt-get; then
    echo "--install needs apt-get (Debian/Ubuntu). On Fedora: sudo dnf install git tmux bubblewrap socat" >&2
    exit 2
  fi
  echo "running: sudo apt-get update && sudo apt-get install -y git tmux bubblewrap socat"
  sudo apt-get update && sudo apt-get install -y git tmux bubblewrap socat || exit 1
fi

if have node; then
  major=$(node -p 'process.versions.node.split(".")[0]')
  if [ "$major" -ge 24 ]; then ok "node $(node -v)"; else bad "node $(node -v): need ≥ 24 (nvm install 24)"; fi
else
  bad "node: install Node 24 (nvm install 24; see the README)"
fi
for tool in git bwrap socat; do
  if have "$tool"; then ok "$tool $(command -v "$tool")"; else
    bad "$tool"
    case $tool in bwrap) missing="$missing bubblewrap" ;; *) missing="$missing $tool" ;; esac
  fi
done
if have tmux; then
  v=$(tmux -V | sed 's/[^0-9.]//g')
  maj=${v%%.*}
  min=${v#*.}
  min=${min%%.*}
  if [ "${maj:-0}" -gt 3 ] || { [ "${maj:-0}" -eq 3 ] && [ "${min:-0}" -ge 2 ]; }; then ok "$(tmux -V)"; else bad "$(tmux -V): need ≥ 3.2"; fi
else
  bad "tmux"
  missing="$missing tmux"
fi
if have claude || [ -x "$HOME/.local/bin/claude" ]; then ok "claude"; else bad "claude: install Claude Code (see the README), then run claude once to log in"; fi
if have pnpm || have corepack; then ok "pnpm/corepack"; else bad "pnpm: corepack enable (ships with Node)"; fi

if have bwrap; then
  if bwrap --ro-bind / / --dev /dev --unshare-net true 2>/dev/null; then ok "bubblewrap runs"; else
    warn "bubblewrap can't run here: Claude Code's sandbox will fail."
    if [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null)" = 1 ]; then
      warn "  AppArmor restricts user namespaces; see 'Ubuntu AppArmor' in Claude Code's sandboxing docs"
    fi
  fi
fi
if systemctl --user is-system-running >/dev/null 2>&1 || [ "$(systemctl --user is-system-running 2>/dev/null)" = degraded ]; then
  ok "systemd user manager"
else
  warn "no systemd user manager for this shell: log in as $(id -un) over SSH or a console (not su/sudo)"
fi
if [ "$(loginctl show-user "$(id -un)" -p Linger 2>/dev/null)" = "Linger=yes" ]; then ok "linger"; else
  warn "linger is off: run once  sudo loginctl enable-linger $(id -un)"
fi

if [ -n "$missing" ]; then
  echo
  echo "Install the missing packages with:"
  echo "  sudo apt-get install -y$missing"
  echo "or rerun this script with --install."
fi
[ "$problems" = 0 ]

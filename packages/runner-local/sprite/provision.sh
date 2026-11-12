#!/bin/sh
# sf-sprite:provision
# The software factory's agent toolchain in a fresh sprite (ADR 0480): what the agent image's
# Dockerfile (`../container/Dockerfile`, ADR 0430) gives a container, on Sprites' own Linux image,
# which can't be replaced. Claude Code is pinned to the Dockerfile's version and installed in its own
# prefix, never the sprite's preinstalled one. Run by the runner once per job, before the job's
# files go in:
#
#   sh -c "$(cat provision.sh)" sf <claude-code-version> <prefix>
set -eu
version="$1"
prefix="$2"
SUDO="${SF_SUDO-sudo -n}"
if [ "$(id -u)" = 0 ]; then SUDO=""; fi

# The toolchain an agent expects, as in the Dockerfile: git, a compiler and Python for native
# modules, ps for the runner's launch check, curl, jq and ripgrep.
missing=""
for tool in git make gcc python3 ps curl jq rg sha256sum node npm; do
  command -v "$tool" >/dev/null 2>&1 || missing="$missing $tool"
done
if [ -n "$missing" ]; then
  $SUDO apt-get update -q >/dev/null
  $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y -q --no-install-recommends \
    build-essential ca-certificates coreutils curl git jq procps python3 ripgrep nodejs npm >/dev/null
fi

$SUDO mkdir -p "$prefix"
$SUDO chown "$(id -u):$(id -g)" "$prefix"
# The Node that runs the status hook, at a path the harness can name.
ln -sf "$(command -v node)" "$prefix/node"
if [ "$("$prefix/bin/claude" --version 2>/dev/null | cut -d' ' -f1)" != "$version" ]; then
  npm install -g --prefix "$prefix" --no-fund --no-audit --loglevel=error \
    "@anthropic-ai/claude-code@$version" >/dev/null
fi
corepack enable >/dev/null 2>&1 || $SUDO corepack enable >/dev/null 2>&1 || true
echo "provisioned: claude $("$prefix/bin/claude" --version 2>/dev/null | cut -d' ' -f1), node $(node --version)"

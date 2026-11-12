#!/bin/sh
# Runs the runner's Linux-sensitive tests inside a Debian container (spec 34, ADR 0420):
# runner-local's real-tmux test, the harness tests (deny lists, /proc command lines) and the
# runner-host unit tests, on Linux, from this checkout's files.
#
#   local/runner-host/scripts/linux-check.sh          # needs Docker or OrbStack's docker
#   SF_LINUX_IMAGE=node:24-trixie local/runner-host/scripts/linux-check.sh
#
# Without a container runtime it says so and exits 0 (skipped). Nothing on this machine changes:
# the tracked and untracked (not ignored) files are copied into a throwaway container
# (`docker run --rm`), which installs git, tmux and the workspace's packages itself and runs the
# tests as the unprivileged `node` user. No secrets or tokens go in; the container needs the network
# for apt and the npm registry.
set -eu
image=${SF_LINUX_IMAGE:-node:24-bookworm}
repo=$(cd "$(dirname "$0")/../../.." && pwd -P)

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  echo "linux-check: skipped (no docker or OrbStack running here)"
  exit 0
fi

echo "linux-check: $repo in $image"
cd "$repo"
git ls-files -z --cached --others --exclude-standard |
  COPYFILE_DISABLE=1 tar --null -T - -cf - |
  docker run -i --rm -e CI=1 "$image" sh -euc '
    mkdir -p /home/node/w
    tar --warning=no-unknown-keyword -xf - -C /home/node/w
    chown -R node:node /home/node/w
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq >/dev/null </dev/null
    apt-get install -y -qq git tmux >/dev/null </dev/null
    tmux -V
    exec runuser -u node -- sh -euc "
      cd /home/node/w
      export COREPACK_ENABLE_DOWNLOAD_PROMPT=0 COREPACK_HOME=/home/node/.corepack
      corepack pnpm --version
      corepack pnpm install --frozen-lockfile --reporter=silent \
        --filter @software-factory/runner-local... \
        --filter @software-factory/harness-claude... \
        --filter @software-factory/runner-host...
      corepack pnpm --filter @software-factory/harness-claude test
      corepack pnpm --filter @software-factory/runner-local exec vitest run --reporter=verbose test/tmux.integration.test.ts | tee /tmp/tmux.out
      if grep -q skipped /tmp/tmux.out; then echo linux-check: the tmux test was skipped >&2; exit 1; fi
      corepack pnpm --filter @software-factory/runner-local test
      corepack pnpm --filter @software-factory/runner-host test
    "
  '
echo "linux-check: passed on $image"

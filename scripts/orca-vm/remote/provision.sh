#!/usr/bin/env bash
# Runs INSIDE a fresh sprite. Installs the headless Orca server, pnpm and gh's git helper, and
# clones the repo to ORCA_PROJECT_ROOT. Idempotent: a re-run skips what is already in place.
# stdin: line 1 the GitHub token (may be empty; the repo is public). Used only for this clone.
set -euo pipefail

: "${ORCA_PROJECT_ROOT:?}" "${ORCA_REPO_URL:?}" "${ORCA_REPO_REF:?}" "${ORCA_SERVER_VERSION:?}"
IFS= read -r gh_token || true

export PATH="$HOME/.local/bin:$PATH"
mkdir -p "$HOME/.local/bin" "$HOME/.local/opt"

# 1. The headless Orca server (bundles its own Node), checksum-verified, pinned to a version.
case "$(uname -m)" in
  x86_64) orca_arch=x64 ;;
  aarch64 | arm64) orca_arch=arm64 ;;
  *) echo "unsupported architecture $(uname -m)" >&2; exit 1 ;;
esac
orca_dir="$HOME/.local/opt/orca-server-$ORCA_SERVER_VERSION-linux-$orca_arch"
if [ ! -x "$orca_dir/bin/orca-ide" ]; then
  echo "installing orca server $ORCA_SERVER_VERSION ($orca_arch)" >&2
  base="https://github.com/stablyai/orca/releases/download/v$ORCA_SERVER_VERSION"
  tmp="$(mktemp -d)"
  curl -fsSL "$base/orca-server-linux-$orca_arch.tar.gz" -o "$tmp/orca.tar.gz"
  curl -fsSL "$base/orca-server-sha256sums.txt" -o "$tmp/sums.txt"
  expected="$(awk -v f="orca-server-linux-$orca_arch.tar.gz" '$2==f{print $1}' "$tmp/sums.txt")"
  [ -n "$expected" ] || { echo "no checksum for orca-server-linux-$orca_arch.tar.gz" >&2; exit 1; }
  actual="$(sha256sum "$tmp/orca.tar.gz" | awk '{print $1}')"
  [ "$expected" = "$actual" ] || { echo "orca server checksum mismatch" >&2; exit 1; }
  tar -xzf "$tmp/orca.tar.gz" -C "$HOME/.local/opt"
  rm -rf "$tmp"
fi
ln -sfn "$orca_dir/bin/orca-ide" "$HOME/.local/bin/orca-ide"
orca-ide --version >&2 || true

# 2. Node 24 and pnpm, as the repo pins them (.nvmrc, packageManager).
node_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "$node_major" -lt 24 ]; then
  echo "node $(node --version 2>/dev/null || echo none) is older than 24" >&2
  exit 1
fi
if ! command -v pnpm >/dev/null 2>&1; then
  npm install -g --prefix "$HOME/.local" pnpm@10.23.0 >&2
fi

# 3. gh as git's credential helper. It reads GH_TOKEN from orca serve's environment at run time,
#    so no token is stored on disk.
if command -v gh >/dev/null 2>&1; then
  gh auth setup-git --hostname github.com >&2 2>&1 || git config --global credential.https://github.com.helper '!gh auth git-credential'
fi

# 4. The primary checkout Orca makes linked worktrees from.
export GIT_TERMINAL_PROMPT=0
askpass=""
if [ -n "$gh_token" ]; then
  askpass="$(mktemp)"
  # \$1 and \$GH_TOKEN stay literal in the helper and resolve when git runs it.
  printf '%s\n' '#!/usr/bin/env bash' 'case "$1" in *Username*) echo x-access-token ;; *) echo "$GH_TOKEN" ;; esac' >"$askpass"
  chmod 700 "$askpass"
  export GIT_ASKPASS="$askpass" GH_TOKEN="$gh_token"
fi
cleanup() { if [ -n "$askpass" ]; then rm -f "$askpass"; fi; }
trap cleanup EXIT
if [ ! -d "$ORCA_PROJECT_ROOT/.git" ]; then
  git clone --branch "$ORCA_REPO_REF" "$ORCA_REPO_URL" "$ORCA_PROJECT_ROOT" >&2
else
  git -C "$ORCA_PROJECT_ROOT" fetch origin "$ORCA_REPO_REF" >&2
  git -C "$ORCA_PROJECT_ROOT" checkout -B "$ORCA_REPO_REF" FETCH_HEAD >&2
fi
echo "provisioned $ORCA_PROJECT_ROOT at $(git -C "$ORCA_PROJECT_ROOT" rev-parse --short HEAD)" >&2

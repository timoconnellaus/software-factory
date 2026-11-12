#!/usr/bin/env bash
# Runs INSIDE the sprite. Restarts orca serve and prints the recipe JSON it writes.
# stdin: line 1 the Claude Code OAuth token, line 2 the GitHub token (either may be empty).
# They live only in the serve process's environment, never in a file.
set -euo pipefail

: "${ORCA_PORT:?}" "${ORCA_PROJECT_ROOT:?}" "${ORCA_PAIRING_ADDRESS:?}"
IFS= read -r claude_token || true
IFS= read -r gh_token || true

export PATH="$HOME/.local/bin:$PATH"
command -v orca-ide >/dev/null 2>&1 || { echo "orca-ide is not installed; run provision first" >&2; exit 1; }
[ -d "$ORCA_PROJECT_ROOT/.git" ] || { echo "no checkout at $ORCA_PROJECT_ROOT" >&2; exit 1; }

run_dir="$HOME/.orca-sprite"
mkdir -p "$run_dir"
bash "$(dirname "$0")/orca-stop-serve.sh"
rm -f "$run_dir/recipe.json" "$run_dir/serve.log"

# setsid detaches serve from this exec session so it outlives it. The launcher hands off to a
# detached orcad process; stop-serve.sh finds that through its instance lock.
env ${claude_token:+CLAUDE_CODE_OAUTH_TOKEN="$claude_token"} ${gh_token:+GH_TOKEN="$gh_token"} \
  setsid nohup orca-ide serve \
    --port "$ORCA_PORT" \
    --project-root "$ORCA_PROJECT_ROOT" \
    --pairing-address "$ORCA_PAIRING_ADDRESS" \
    --recipe-json >"$run_dir/recipe.json" 2>"$run_dir/serve.log" </dev/null &
pid=$!
unset claude_token gh_token

for _ in $(seq 1 240); do
  if node -e 'JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8"))' "$run_dir/recipe.json" >/dev/null 2>&1; then
    cat "$run_dir/recipe.json"
    exit 0
  fi
  if ! kill -0 "$pid" 2>/dev/null; then
    # The launcher hands off to orcad and may exit right after writing the JSON.
    if node -e 'JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8"))' "$run_dir/recipe.json" >/dev/null 2>&1; then
      cat "$run_dir/recipe.json"
      exit 0
    fi
    echo "orca serve exited before printing its recipe JSON:" >&2
    cat "$run_dir/serve.log" >&2
    exit 1
  fi
  sleep 0.25
done
echo "orca serve did not print its recipe JSON within 60s:" >&2
cat "$run_dir/serve.log" >&2
exit 1

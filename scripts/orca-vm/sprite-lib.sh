# Shared helpers for the Fly Sprites per-workspace recipe. Sourced, not run.
# Every script reserves stdout for its one JSON result; everything here logs to stderr.

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
state_file="${ORCA_SPRITE_STATE_FILE:-$script_dir/sprite-state.json}"

log() { printf '[orca-sprite] %s\n' "$*" >&2; }
die() { log "error: $*"; exit 1; }

command -v sprite >/dev/null 2>&1 || die "the sprite CLI is not installed (https://docs.fly.io/sprites)"
command -v node >/dev/null 2>&1 || die "node is required on this machine to read the state file and lifecycle payloads"

# json_value <key>: a top-level value from the state file, or empty.
json_value() {
  [ -f "$state_file" ] || return 0
  node -e 'const fs=require("node:fs");const v=JSON.parse(fs.readFileSync(process.argv[1],"utf8"))[process.argv[2]];if(v!==undefined&&v!==null)process.stdout.write(String(v))' "$state_file" "$1"
}

# env_value <ENV_NAME> <stateKey> [fallback]: env var, then state, then fallback.
env_value() {
  local from_env="${!1:-}"
  if [ -n "$from_env" ]; then printf '%s' "$from_env"; return; fi
  local from_state
  from_state="$(json_value "$2")"
  if [ -n "$from_state" ]; then printf '%s' "$from_state"; return; fi
  printf '%s' "${3:-}"
}

sprite_org="$(env_value ORCA_SPRITE_ORG org)"
sprite_args=()
[ -n "$sprite_org" ] && sprite_args+=(-o "$sprite_org")

# sprite_cmd <args...>: the sprite CLI with the configured org (safe for an empty array on bash 3.2).
sprite_cmd() { sprite ${sprite_args[@]+"${sprite_args[@]}"} "$@"; }

# sprite_name_for <recipeId> <instanceId>: a stable, DNS-safe sprite name per workspace instance,
# so destroy can find a sprite whose create never returned a result.
sprite_name_for() {
  local raw
  raw="$(printf 'orca-%s-%s' "$1" "$2" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9-]+/-/g; s/-+/-/g; s/^-//; s/-$//')"
  # The sprite URL is <name>-<org-id>.sprites.app, one DNS label (63 chars), so keep the name short.
  # Keep the tail: the instance id is what makes the name unique.
  if [ "${#raw}" -gt 40 ]; then raw="orca-${raw: -35}"; raw="${raw//--/-}"; fi
  printf '%s' "$raw"
}

# payload_value <payload-json> <dotted.path>: a value from Orca's lifecycle payload, or empty.
payload_value() {
  node -e 'let d;try{d=JSON.parse(process.argv[1])}catch{process.exit(0)}for(const k of process.argv[2].split("."))d=d?.[k];if(d!==undefined&&d!==null)process.stdout.write(String(d))' "$1" "$2"
}

# resource_from_payload <payload-json>: userData.resourceId, or the name derived from the instance id.
resource_from_payload() {
  local id instance recipe
  id="$(payload_value "$1" recipeResult.userData.resourceId)"
  if [ -n "$id" ]; then printf '%s' "$id"; return; fi
  instance="$(payload_value "$1" instanceId)"
  instance="${instance:-${ORCA_VM_INSTANCE_ID:-}}"
  recipe="$(payload_value "$1" recipeId)"
  recipe="${recipe:-${ORCA_RECIPE_ID:-sprite}}"
  [ -n "$instance" ] || return 0
  sprite_name_for "$recipe" "$instance"
}

# Credentials. Read at run time, passed to the sprite on stdin, never written anywhere.
gh_token() {
  if [ -n "${GH_TOKEN:-}" ]; then printf '%s' "$GH_TOKEN"; return; fi
  if [ -n "${GITHUB_TOKEN:-}" ]; then printf '%s' "$GITHUB_TOKEN"; return; fi
  command -v gh >/dev/null 2>&1 && gh auth token 2>/dev/null || true
}

# The long-lived Claude Code token from `claude setup-token`, kept in the macOS Keychain under
# this service name (see scripts/orca-vm/README.md). CLAUDE_CODE_OAUTH_TOKEN overrides it.
claude_keychain_service="${ORCA_SPRITE_CLAUDE_KEYCHAIN_SERVICE:-orca-sprite-claude-token}"
claude_token() {
  if [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then printf '%s' "$CLAUDE_CODE_OAUTH_TOKEN"; return; fi
  command -v security >/dev/null 2>&1 \
    && security find-generic-password -s "$claude_keychain_service" -w 2>/dev/null || true
}

# start_serve <sprite-name>: (re)start orca serve in the sprite and print its recipe JSON merged
# with our userData. Secrets go over stdin so they never appear in a local or remote argv.
start_serve() {
  local name="$1" url pairing token_claude token_gh recipe_json
  url="$(sprite_url "$name")"
  [ -n "$url" ] || die "could not read the URL of sprite $name (sprite info)"
  pairing="wss://${url#https://}"
  pairing="${pairing%/}"
  token_claude="$(claude_token)"
  token_gh="$(gh_token)"
  [ -n "$token_claude" ] || log "warning: no Claude token (Keychain service $claude_keychain_service or CLAUDE_CODE_OAUTH_TOKEN); Claude Code in this workspace starts signed out"
  [ -n "$token_gh" ] || log "warning: no GitHub token (GH_TOKEN, GITHUB_TOKEN or gh auth token); git push and gh in this workspace will fail"
  recipe_json="$(printf '%s\n%s\n' "$token_claude" "$token_gh" | sprite_cmd exec -s "$name" --stdin \
    --file "$script_dir/remote/start-serve.sh:/tmp/orca-start-serve.sh" \
    --file "$script_dir/remote/stop-serve.sh:/tmp/orca-stop-serve.sh" \
    --env "ORCA_PORT=$serve_port,ORCA_PROJECT_ROOT=$project_root,ORCA_PAIRING_ADDRESS=$pairing" \
    -- bash /tmp/orca-start-serve.sh)"
  node -e 'const p=JSON.parse(process.argv[1]);process.stdout.write(JSON.stringify({...p,schemaVersion:1,userData:{...(p.userData||{}),provider:"fly-sprites",resourceId:process.argv[2],org:process.argv[3]||undefined,url:process.argv[4]}})+"\n")' \
    "$recipe_json" "$name" "$sprite_org" "$url"
}

# sprite_url <name>: the sprite's https URL.
sprite_url() {
  sprite_cmd info "$1" 2>/dev/null | grep -Eo 'https://[A-Za-z0-9.-]+\.sprites\.app' | head -1
}

serve_port="$(env_value ORCA_SPRITE_PORT port 8080)"
project_root="$(env_value ORCA_SPRITE_PROJECT_ROOT projectRoot /home/sprite/software-factory)"

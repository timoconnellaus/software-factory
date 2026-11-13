#!/usr/bin/env bash
# Orca recipe `create`: a fresh Fly sprite per workspace, running orca serve on its public URL.
# Prints one recipe-result JSON object on stdout; progress goes to stderr.
set -euo pipefail
source "$(dirname "$0")/sprite-lib.sh"

repo_url="$(env_value ORCA_SPRITE_REPO_URL repoUrl https://github.com/timoconnellaus/software-factory.git)"
repo_ref="$(env_value ORCA_SPRITE_REPO_REF repoRef main)"
server_version="$(env_value ORCA_SERVER_VERSION orcaServerVersion)"
[ -n "$server_version" ] || die "orcaServerVersion is missing from $state_file"

recipe_id="${ORCA_RECIPE_ID:-sprite}"
instance_id="${ORCA_VM_INSTANCE_ID:-manual-$(date +%s)}"
name="$(sprite_name_for "$recipe_id" "$instance_id")"

created=0
cleanup_on_error() {
  local code=$?
  if [ "$code" -ne 0 ] && [ "$created" -eq 1 ]; then
    log "create failed; destroying sprite $name"
    sprite_cmd destroy --force "$name" >&2 || log "cleanup failed: destroy sprite $name by hand"
  fi
  exit "$code"
}
trap cleanup_on_error EXIT

# Idempotent per instance: a retried create reuses the sprite instead of leaking a second one.
if sprite_cmd list 2>/dev/null | grep -Eq "(^|[[:space:]])$name([[:space:]]|$)"; then
  log "reusing sprite $name"
else
  log "creating sprite $name"
  sprite_cmd create --skip-console --label orca-recipe "$name" >&2
fi
created=1

# Orca desktop dials the URL directly, so it can't send Fly org auth. The pairing code gates access.
sprite_cmd config update --url-auth public "$name" >&2

log "provisioning $name (orca server $server_version, $repo_url@$repo_ref)"
gh_token | sprite_cmd exec -s "$name" --stdin \
  --file "$script_dir/remote/provision.sh:/tmp/orca-provision.sh" \
  --env "ORCA_PROJECT_ROOT=$project_root,ORCA_REPO_URL=$repo_url,ORCA_REPO_REF=$repo_ref,ORCA_SERVER_VERSION=$server_version" \
  -- bash /tmp/orca-provision.sh >&2

log "starting orca serve in $name"
start_serve "$name"
trap - EXIT

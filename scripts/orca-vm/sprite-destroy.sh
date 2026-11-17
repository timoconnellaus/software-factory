#!/usr/bin/env bash
# Orca recipe `destroy`: delete the workspace's sprite. Works without a recipe result too (a create
# that never returned), by deriving the name from the instance id.
set -euo pipefail
source "$(dirname "$0")/sprite-lib.sh"
payload="$(cat)"
name="$(resource_from_payload "$payload")"
[ -n "$name" ] || die "no resource id or instance id in the lifecycle payload"
if sprite_cmd list 2>/dev/null | grep -Eq "(^|[[:space:]])$name([[:space:]]|$)"; then
  sprite_cmd destroy --force "$name" >&2
else
  log "sprite $name is already gone"
fi
printf '{"ok":true}\n'

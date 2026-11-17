#!/usr/bin/env bash
# Orca recipe `suspend`: stop orca serve so nothing holds the sprite awake; Sprites then pause it
# when idle and stop billing compute. The filesystem stays. `resume` starts serve again.
set -euo pipefail
source "$(dirname "$0")/sprite-lib.sh"
payload="$(cat)"
name="$(resource_from_payload "$payload")"
[ -n "$name" ] || die "no resource id or instance id in the lifecycle payload"
sprite_cmd exec -s "$name" --no-stdin \
  --file "$script_dir/remote/stop-serve.sh:/tmp/orca-stop-serve.sh" \
  -- bash /tmp/orca-stop-serve.sh >&2
printf '{"ok":true}\n'

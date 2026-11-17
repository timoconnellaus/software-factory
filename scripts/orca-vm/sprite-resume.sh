#!/usr/bin/env bash
# Orca recipe `resume`: restart orca serve in the sprite (a cold boot kills it) and re-emit the
# recipe JSON, since the pairing may have changed.
set -euo pipefail
source "$(dirname "$0")/sprite-lib.sh"
payload="$(cat)"
name="$(resource_from_payload "$payload")"
[ -n "$name" ] || die "no resource id or instance id in the lifecycle payload"
start_serve "$name"

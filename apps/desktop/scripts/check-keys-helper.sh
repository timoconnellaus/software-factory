#!/bin/sh
# Checks the key helper in a shipped copy of the app (spec 40 M4b, ADR 0394), as a downloaded or
# updated Mac gets it: run by the release on the app from the download zip and from the update
# archive. Fails on the first thing that isn't so.
#
#   sh scripts/check-keys-helper.sh <app> <team id> <profile> [--no-assess]
#
# --no-assess skips Gatekeeper (spctl and the stapled ticket), for a local build that wasn't
# notarized.
set -eu
app="$1"; team="$2"; profile="$3"; assess="${4:-}"
helper="$app/Contents/Helpers/SF Keys.app"
group="$team.com.software-factory.desktop.keys"
say() { echo "check-keys-helper: $*"; }
die() { echo "::error::check-keys-helper: $*"; exit 1; }

[ -d "$helper" ] || die "no $helper"

# The app as a whole, and the helper's own designated requirement: our identifier, our team.
codesign --verify --deep --strict "$app" || die "the app's seal doesn't verify"
codesign --verify --strict -R="anchor apple generic and identifier \"com.software-factory.desktop.keys\" and certificate leaf[subject.OU] = \"$team\"" "$helper" \
  || die "the helper doesn't satisfy its requirement"

info=$(codesign -dvvv "$helper" 2>&1)
echo "$info" | grep -q '^Identifier=com.software-factory.desktop.keys$' || die "wrong identifier"
echo "$info" | grep -q "^TeamIdentifier=$team\$" || die "wrong team"
echo "$info" | grep -q '^Timestamp=' || die "no secure timestamp (Signed Time instead)"
echo "$info" | grep -q 'flags=0x10000(runtime)' || die "not hardened runtime only (flags)"

# Its entitlements are exactly the three ADR 0394 names, with this team's values.
ents=$(codesign -d --entitlements - --xml "$helper" 2>/dev/null)
keys=$(printf %s "$ents" | plutil -convert json -o - - | /usr/bin/python3 -c 'import json,sys; print(" ".join(sorted(json.load(sys.stdin))))')
[ "$keys" = "com.apple.application-identifier com.apple.developer.team-identifier keychain-access-groups" ] \
  || die "the helper's entitlements are: $keys"
printf %s "$ents" | grep -q "<string>$group</string>" || die "the helper has no $group"

# The embedded profile is the one the release was given, byte for byte.
cmp -s "$helper/Contents/embedded.provisionprofile" "$profile" || die "the embedded profile isn't MACOS_KEYS_PROFILE"

# No other code in the bundle carries an access group.
find "$app" -type f -perm -u+x | while IFS= read -r f; do
  case "$f" in "$helper"/*) continue ;; esac
  if codesign -d --entitlements - "$f" 2>/dev/null | grep -q keychain-access-groups; then
    die "$f has a keychain access group"
  fi
done

if [ "$assess" != "--no-assess" ]; then
  spctl --assess --type execute --verbose=2 "$app" || die "Gatekeeper refuses the app"
  xcrun stapler validate "$app" || die "the app has no stapled ticket"
fi

# The launch smoke test: macOS kills (SIGKILL, 137) a helper whose profile doesn't authorise its
# entitlements; the spike's helper prints them and exits 0.
set +e
out=$("$helper/Contents/MacOS/sf-keys")
code=$?
set -e
[ "$code" -eq 0 ] || die "the helper exited $code (137 is SIGKILL: macOS refused it)"
printf %s "$out" | grep -q "\"$group\"" || die "the running helper doesn't hold $group: $out"
say "ok: $helper ($out)"

#!/bin/sh
# Builds the .app (macOS only; ADR 0390): the view, the bundled Node 24 and sf-runner, the key
# helper (only with SF_KEYS_PROFILE), then Electrobun's bundle for the given environment
# (dev | canary | stable).
set -e
cd "$(dirname "$0")/.."
env="${1:-dev}"
export PATH="$HOME/.hutch/bin:$PATH"
mkdir -p vendor
node scripts/vendor-node.mjs
node scripts/bundle-runner.mjs
rm -f vendor/sf-keys
# The key helper bundle (spec 40 M4b, ADR 0394), only when the release has its provisioning profile
# (SF_KEYS_PROFILE, a path; from MACOS_KEYS_PROFILE). It is unsigned here: the postPackage hook
# puts it in Contents/Helpers and signs it after Electrobun's own signing (scripts/keys-helper.ts).
rm -rf "vendor/SF Keys.app"
if [ -n "${SF_KEYS_PROFILE:-}" ]; then
  helper="vendor/SF Keys.app/Contents"
  mkdir -p "$helper/MacOS"
  # Built for macOS 14, the helper's LSMinimumSystemVersion (not the build machine's macOS), and
  # arm64 only, as the app ships.
  swift build -c release --package-path native/sf-keys-app --triple arm64-apple-macosx14.0
  cp "$(swift build -c release --package-path native/sf-keys-app --triple arm64-apple-macosx14.0 --show-bin-path)/sf-keys" "$helper/MacOS/sf-keys"
  cp native/sf-keys-app/Info.plist "$helper/Info.plist"
  cp "$SF_KEYS_PROFILE" "$helper/embedded.provisionprofile"
  echo "bundle: key helper built (vendor/SF Keys.app)"
else
  echo "bundle: no key helper (SF_KEYS_PROFILE is not set)"
fi
pnpm exec electrobun prepare
pnpm exec vite build
pnpm exec electrobun build --env="$env"

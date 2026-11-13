#!/bin/sh
# Release check (spec 40 M4): an app that is moved after its first run must still be able to
# update. Electrobun's update helper refuses an update (InvalidUpdateIdentity) unless its install
# record names the running bundle, and the launcher writes that record only on the first run. The
# app rewrites it at start with its own bundled helper (src/bun/install-record.ts). This runs the
# same helper the same way, under a throwaway HOME: first run in one place, then moved, then the
# app's rewrite, and the record must name where the app now is.
# Usage: check-install-record.sh <path to a built .app> <channel>
set -eu
app=$1
channel=$2
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
name=$(basename "$app")
root="$work/home/Library/Application Support/com.software-factory.desktop/$channel"
mkdir -p "$root" "$work/first" "$work/moved"
ditto "$app" "$work/first/$name"

record() { node -p "require(process.argv[1]).app_bundle_path" "$root/.electrobun-uninstall.json"; }

# The launcher's first-run bootstrap, from where the app was first opened.
HOME="$work/home" "$work/first/$name/Contents/Resources/uninstall" --bootstrap-install "$root" --quiet
first=$(cd "$work/first" && pwd -P)/$name
[ "$(record)" = "$first" ] || { echo "::error::first run recorded $(record), not $first"; exit 1; }

# Moved (Downloads to Applications): the record still names the old place.
mv "$work/first/$name" "$work/moved/$name"
moved=$(cd "$work/moved" && pwd -P)/$name
[ "$(record)" != "$moved" ] || { echo "::error::the record followed the move on its own?"; exit 1; }

# What the app does at start when the record names another bundle.
HOME="$work/home" "$moved/Contents/Resources/uninstall" --bootstrap-install "$root" --quiet
[ "$(record)" = "$moved" ] || { echo "::error::after the rewrite the record names $(record), not $moved"; exit 1; }
[ -x "$root/uninstall" ] || { echo "::error::no helper copy beside the record"; exit 1; }
echo "install record follows a moved app ($moved)"

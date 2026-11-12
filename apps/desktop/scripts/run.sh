#!/bin/sh
# Runs the dev bundle from its MacOS directory, with its console in this terminal.
set -e
cd "$(dirname "$0")/.."
app=$(ls -d build/dev-macos-arm64/*.app)
cd "$app/Contents/MacOS"
exec ./launcher

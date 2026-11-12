#!/bin/sh
# Rebuild (dev env: flat files, no self-extractor) and launch from the bundle, logging to $1.
set -e
cd "$(dirname "$0")/.."
export PATH="$HOME/.hutch/bin:$PATH"
pnpm -s build:view >/dev/null
hutch electrobun build --env=dev >/dev/null
app=$(ls -d build/dev-macos-arm64/*.app)
cd "$app/Contents/MacOS"
exec ./launcher

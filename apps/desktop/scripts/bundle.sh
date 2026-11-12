#!/bin/sh
# Builds the .app (macOS only; ADR 0370): the view, the bundled Node 24 and sf-runner, the Secure
# Enclave helper, then Electrobun's bundle for the given environment (dev | canary | stable).
set -e
cd "$(dirname "$0")/.."
env="${1:-dev}"
export PATH="$HOME/.hutch/bin:$PATH"
mkdir -p vendor
node scripts/vendor-node.mjs
node scripts/bundle-runner.mjs
swiftc -O -o vendor/sf-keys native/sf-keys.swift
pnpm exec electrobun prepare
pnpm exec vite build
pnpm exec electrobun build --env="$env"

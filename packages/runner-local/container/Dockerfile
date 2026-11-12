# The software factory's agent image (ADR 0430): what a job's Claude Code runs in, on a runner set
# to container isolation, and later in cloud sandboxes (plan piece 7). The runner builds it from this
# directory and tags it by the directory's content hash (`software-factory-agent:<12 hex>`), so any
# change here is a new image. The runner starts it with no home, no host credentials, a read-only
# root, every capability dropped, and egress only through the job's proxy (`egress-proxy.mjs`, the
# same image).
FROM node:24-bookworm-slim

# Claude Code, pinned: bump it here and every runner rebuilds on its next job.
ARG CLAUDE_CODE_VERSION=2.1.322

# The toolchain an agent expects: git, a compiler and Python for native modules, ps for the
# runner's launch check, curl, jq and ripgrep.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    build-essential ca-certificates curl git jq less procps python3 ripgrep unzip \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g --no-fund --no-audit "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
  && npm cache clean --force \
  && corepack enable

COPY egress-proxy.mjs /opt/software-factory/egress-proxy.mjs

# No auto-update (the image pins the version) and no telemetry or other traffic the egress
# allowlist would refuse anyway. Node's own fetch and http honour HTTPS_PROXY.
ENV DISABLE_AUTOUPDATER=1 \
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
  NODE_USE_ENV_PROXY=1 \
  LANG=C.UTF-8

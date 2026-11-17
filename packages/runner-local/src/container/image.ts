// The agent image (ADR 0661): what a container job's Claude Code runs in. The Dockerfile is here as
// text (the runner ships as one bundled file) and the image is tagged by its hash, so a change to it
// is a new image that every runner builds on its next job.
import { createHash } from "node:crypto";
import type { ContainerRuntime } from "./runtime.ts";

export const IMAGE_REPOSITORY = "software-factory-agent";
/** The image's Node, which runs the status hook. */
export const IMAGE_NODE = "/usr/local/bin/node";

/** Claude Code, pinned: bump it here and every runner builds a new image on its next job. */
export const CLAUDE_CODE_VERSION = "2.1.326";

export const DOCKERFILE = `# The software factory's agent image (ADR 0661), built by the runner from this text.
FROM node:24-bookworm-slim

# The toolchain an agent expects: git, a compiler and Python for native modules, ps for the
# runner's launch check, curl, jq and ripgrep.
RUN apt-get update \\
  && apt-get install -y --no-install-recommends \\
    build-essential ca-certificates curl git jq less procps python3 ripgrep unzip \\
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g --no-fund --no-audit "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \\
  && npm cache clean --force \\
  && corepack enable

# The image pins the version: no auto-update.
ENV DISABLE_AUTOUPDATER=1 \\
  LANG=C.UTF-8
`;

export const imageTag = (dockerfile = DOCKERFILE) =>
  `${IMAGE_REPOSITORY}:${createHash("sha256").update(dockerfile).digest("hex").slice(0, 12)}`;

const building = new Map<string, Promise<string>>();

/**
 * The image's id, building it when this host doesn't have it yet (a few minutes, once). One build
 * per tag per process, however many jobs ask at once.
 */
export async function ensureImage(
  runtime: ContainerRuntime,
  options: { dockerfile?: string; log?: (m: string) => void } = {},
): Promise<string> {
  const dockerfile = options.dockerfile ?? DOCKERFILE;
  const tag = imageTag(dockerfile);
  const have = await runtime.imageId(tag);
  if (have) return have;
  let build = building.get(tag);
  if (!build) {
    build = (async () => {
      options.log?.(`building the agent image ${tag} (first use on this machine; a few minutes)`);
      await runtime.build(dockerfile, tag);
      const id = await runtime.imageId(tag);
      if (!id) throw new Error(`built ${tag}, but Docker doesn't list it`);
      return id;
    })();
    building.set(tag, build);
    // Settled either way: the next job asks Docker again (and retries a failed build).
    const forget = () => building.delete(tag);
    build.then(forget, forget);
  }
  return build;
}

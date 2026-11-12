// The agent image (ADR 0430): built from `packages/runner-local/container/` on the runner host, on
// first use or by `sf-runner doctor --fix`, and tagged by that directory's content hash, so editing
// the Dockerfile or the proxy is a new image and every runner rebuilds on its next job. Jobs run the
// image by id, which the launch check compares.
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ContainerRuntime } from "./runtime.ts";

/** The build context: the Dockerfile and the egress proxy. */
export const IMAGE_CONTEXT = fileURLToPath(new URL("../../container/", import.meta.url));
export const IMAGE_REPOSITORY = "software-factory-agent";
/** Where the proxy script is inside the image. */
export const EGRESS_SCRIPT = "/opt/software-factory/egress-proxy.mjs";
/** The image's Node, which runs the status hook and the proxy. */
export const IMAGE_NODE = "/usr/local/bin/node";

/** sha256 over the context's files (names and bytes, sorted), 12 hex. */
export async function contextHash(context = IMAGE_CONTEXT): Promise<string> {
  const hash = createHash("sha256");
  const files = (await readdir(context, { withFileTypes: true }))
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .sort();
  for (const name of files) {
    hash.update(`${name}\0`);
    hash.update(await readFile(join(context, name)));
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 12);
}

export async function imageTag(context = IMAGE_CONTEXT): Promise<string> {
  return `${IMAGE_REPOSITORY}:${await contextHash(context)}`;
}

export interface AgentImage {
  tag: string;
  id: string;
  built: boolean;
}

const building = new Map<string, Promise<AgentImage>>();

/**
 * The agent image's id, building it when this host doesn't have it yet. One build per tag per
 * process, however many jobs ask at once.
 */
export async function ensureImage(
  runtime: ContainerRuntime,
  options: { context?: string; log?: (m: string) => void } = {},
): Promise<AgentImage> {
  const context = options.context ?? IMAGE_CONTEXT;
  const tag = await imageTag(context);
  const have = await runtime.imageId(tag);
  if (have) return { tag, id: have, built: false };
  const key = `${runtime.bin}\0${tag}`;
  let build = building.get(key);
  if (!build) {
    build = (async () => {
      options.log?.(`building the agent image ${tag} (first use on this host; a few minutes)`);
      await runtime.build({ context, tag });
      const id = await runtime.imageId(tag);
      if (!id) throw new Error(`built ${tag}, but the runtime doesn't list it`);
      return { tag, id, built: true };
    })();
    building.set(key, build);
    // Settled either way: the next job checks the runtime again (and retries a failed build).
    build.then(
      () => building.delete(key),
      () => building.delete(key),
    );
  }
  return build;
}

/** The image a host has for the current context, without building (for `doctor`). */
export async function currentImage(
  runtime: ContainerRuntime,
  context = IMAGE_CONTEXT,
): Promise<{ tag: string; id: string | null }> {
  const tag = await imageTag(context);
  return { tag, id: await runtime.imageId(tag) };
}

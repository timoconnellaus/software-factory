// The runner's Node 24 (ADR 0390) into vendor/node.
// - Release builds (CI): NODE_DIST_VERSION=24.x.y downloads that release from nodejs.org and checks
//   it against the sha256 pinned below, committed and reviewed with the version. SHASUMS256.txt
//   from the same server isn't trusted: whoever could swap the tarball could swap it too. A version
//   with no pinned hash is refused; to move Node, add its line (from the release's
//   SHASUMS256.txt, checked against its signature) and change NODE_DIST_VERSION in the workflow.
// - In CI (CI=true) NODE_DIST_VERSION is required: a release never ships the runner's own Node.
// - Otherwise: copies the Node running this script (local builds).

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** node-v<version>-darwin-arm64.tar.gz → sha256. */
export const NODE_SHA256 = {
  "24.21.0": "bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057",
};

/** The pinned version and its expected hash, or an error. Exported for the tests. */
export function pinnedNode(env) {
  const pinned = env.NODE_DIST_VERSION?.replace(/^v/, "") || undefined;
  if (!pinned) {
    if (env.CI === "true") throw new Error("NODE_DIST_VERSION must be set in CI");
    return null;
  }
  if (!/^24\.\d+\.\d+$/.test(pinned))
    throw new Error(`NODE_DIST_VERSION must be a Node 24 release, not ${pinned}`);
  const sha256 = NODE_SHA256[pinned];
  if (!sha256) throw new Error(`no sha256 is pinned for Node ${pinned} in scripts/vendor-node.mjs`);
  return { version: pinned, sha256 };
}

async function vendor() {
  mkdirSync("vendor", { recursive: true });
  const node = pinnedNode(process.env);
  const pinned = node?.version;
  if (pinned) {
    const name = `node-v${pinned}-darwin-arm64.tar.gz`;
    const base = `https://nodejs.org/dist/v${pinned}`;
    const tarball = await fetch(`${base}/${name}`).then((r) =>
      r.ok ? r.arrayBuffer() : Promise.reject(new Error(`${name}: ${r.status}`)),
    );
    const want = node.sha256;
    const got = createHash("sha256").update(Buffer.from(tarball)).digest("hex");
    if (want !== got) throw new Error(`${name}: checksum mismatch (want ${want}, got ${got})`);
    const dir = mkdtempSync(join(tmpdir(), "sf-node-"));
    writeFileSync(join(dir, name), Buffer.from(tarball));
    execFileSync("tar", [
      "-xzf",
      join(dir, name),
      "-C",
      dir,
      `node-v${pinned}-darwin-arm64/bin/node`,
    ]);
    copyFileSync(join(dir, `node-v${pinned}-darwin-arm64/bin/node`), "vendor/node");
    rmSync(dir, { recursive: true, force: true });
    console.log(`vendor/node <- nodejs.org v${pinned} (sha256 ${got.slice(0, 12)}…)`);
  } else {
    const [major] = process.versions.node.split(".").map(Number);
    if (major !== 24) throw new Error(`the runner needs Node 24; this is ${process.version}`);
    copyFileSync(process.execPath, "vendor/node");
    console.log(`vendor/node <- ${process.execPath} (${process.version})`);
  }
  chmodSync("vendor/node", 0o755);
}

if (import.meta.url === `file://${process.argv[1]}`) await vendor();

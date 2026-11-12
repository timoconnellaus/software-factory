// The runner's Node 24 (ADR 0390) into vendor/node.
// - Release builds (CI): NODE_DIST_VERSION=24.x.y downloads that release from nodejs.org and checks
//   it against the release's SHASUMS256.txt before using it.
// - Otherwise: copies the Node running this script (local builds).

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

mkdirSync("vendor", { recursive: true });
const pinned = process.env.NODE_DIST_VERSION?.replace(/^v/, "");
if (pinned) {
  if (!/^24\.\d+\.\d+$/.test(pinned))
    throw new Error(`NODE_DIST_VERSION must be a Node 24 release, not ${pinned}`);
  const name = `node-v${pinned}-darwin-arm64.tar.gz`;
  const base = `https://nodejs.org/dist/v${pinned}`;
  const [tarball, sums] = await Promise.all([
    fetch(`${base}/${name}`).then((r) =>
      r.ok ? r.arrayBuffer() : Promise.reject(new Error(`${name}: ${r.status}`)),
    ),
    fetch(`${base}/SHASUMS256.txt`).then((r) =>
      r.ok ? r.text() : Promise.reject(new Error(`SHASUMS256.txt: ${r.status}`)),
    ),
  ]);
  const want = sums
    .split("\n")
    .find((l) => l.endsWith(`  ${name}`))
    ?.split(/\s+/)[0];
  const got = createHash("sha256").update(Buffer.from(tarball)).digest("hex");
  if (!want || want !== got)
    throw new Error(`${name}: checksum mismatch (want ${want}, got ${got})`);
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

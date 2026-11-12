// The runner's Node 24 (ADR 0370): copies the running Node into vendor/node. CI's release build
// downloads the pinned release from nodejs.org and checks it against SHASUMS256 instead (M4).
import { chmodSync, copyFileSync, mkdirSync } from "node:fs";

const [major] = process.versions.node.split(".").map(Number);
if (major !== 24) throw new Error(`the runner needs Node 24; this is ${process.version}`);
mkdirSync("vendor", { recursive: true });
copyFileSync(process.execPath, "vendor/node");
chmodSync("vendor/node", 0o755);
console.log(`vendor/node <- ${process.execPath} (${process.version})`);

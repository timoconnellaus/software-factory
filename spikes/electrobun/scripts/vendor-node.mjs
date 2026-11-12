// Copies the running Node 24 binary into vendor/node. A real build would download a pinned
// release from nodejs.org and check its SHASUMS256 signature instead.
import { copyFileSync, chmodSync, mkdirSync } from "node:fs";
const [major] = process.versions.node.split(".").map(Number);
if (major !== 24) throw new Error(`need Node 24, running ${process.version}`);
mkdirSync("vendor", { recursive: true });
copyFileSync(process.execPath, "vendor/node");
chmodSync("vendor/node", 0o755);
console.log(`vendor/node <- ${process.execPath} (${process.version})`);

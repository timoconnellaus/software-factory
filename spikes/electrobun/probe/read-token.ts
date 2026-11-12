// Run by something other than the app: can it read the app's desktop token?
import { readToken } from "../src/bun/keychain.ts";
const r = readToken("file");
console.log(JSON.stringify({ execPath: process.execPath, status: r.status, gotToken: r.token !== null, preview: r.token?.slice(0, 14) }));

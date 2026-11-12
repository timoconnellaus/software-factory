import { deleteToken } from "../src/bun/keychain.ts";
console.log(JSON.stringify({ deleteStatus: deleteToken("file") }));

// The token never reaches the webview (spec 40 M2 criterion 5): no RPC type mentions one.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("the view's RPC", () => {
  it("has no field for a token, a nonce, a signature or a key", () => {
    const src = readFileSync(new URL("../src/shared/rpc.ts", import.meta.url), "utf8");
    const code = src.replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/\b(token|nonce|signature|privateKey|secret|verifier)\b/i);
  });
});

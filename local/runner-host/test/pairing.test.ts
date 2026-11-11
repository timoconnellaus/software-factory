// Incident 2026-11-11-bootstrap: the app's Copy gave `runner id: …\nkey: …`, `pair --key-stdin`
// took all of it as the key (401 bad signature), and `install` pinned the shell's Node 22.
import { describe, expect, it } from "vitest";
import { parsePairingInput, serviceNode } from "../src/pairing.ts";

const KEY = "Zk3x9QpL2mN8vB4cR7tY1wE5uI0oA6sD";

describe("pair --key-stdin", () => {
  it("takes a bare key", () => {
    expect(parsePairingInput(`${KEY}\n`, "r_abc123")).toEqual({ key: KEY, runnerId: "r_abc123" });
  });

  it("takes the app's two-line block, and its runner id when --runner-id is left out", () => {
    const block = `runner id: r_abc123\nkey: ${KEY}\n`;
    expect(parsePairingInput(block, undefined)).toEqual({ key: KEY, runnerId: "r_abc123" });
    expect(parsePairingInput(block, "r_abc123")).toEqual({ key: KEY, runnerId: "r_abc123" });
  });

  it("says so when the runner id doesn't match the key's", () => {
    expect(() => parsePairingInput(`runner id: r_other1\nkey: ${KEY}`, "r_abc123")).toThrow(
      /Runner id mismatch: --runner-id is r_abc123 but the pasted key is for r_other1/,
    );
  });

  it("refuses anything else rather than sending it as the key", () => {
    expect(() => parsePairingInput("hello\nworld", "r_abc123")).toThrow(/Couldn't read a key/);
    expect(() => parsePairingInput("two words", "r_abc123")).toThrow(/spaces/);
  });
});

describe("install: the service's Node", () => {
  it("refuses Node < 24 and says how to fix it", () => {
    const run = () =>
      serviceNode({
        execPath: "/Users/x/.nvm/versions/node/v22.11.0/bin/node",
        version: "v22.11.0",
        path: "/Users/x/.nvm/versions/node/v22.11.0/bin:/usr/bin:/bin",
      });
    expect(run).toThrow(/needs Node ≥ 24, but it is running on v22\.11\.0/);
    expect(run).toThrow(/SF_RUNNER_NODE=/);
  });

  it("pins the absolute Node ≥ 24 and puts its directory first on PATH", () => {
    const bin = "/Users/x/.nvm/versions/node/v24.21.0/bin";
    expect(
      serviceNode({
        execPath: `${bin}/node`,
        version: "v24.21.0",
        path: `/Users/x/.nvm/versions/node/v22.11.0/bin:/usr/bin:${bin}:/bin`,
      }),
    ).toEqual({
      node: `${bin}/node`,
      path: `${bin}:/Users/x/.nvm/versions/node/v22.11.0/bin:/usr/bin:/bin`,
    });
  });
});

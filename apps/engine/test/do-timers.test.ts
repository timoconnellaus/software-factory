// Spec 44, criterion 1 (AGENTS.md "Cloudflare cost", rules 5 and 6): no Durable Object keeps a
// setTimeout, a setInterval or a held request to wait, and every one that accepts sockets answers
// its ping without waking. A Durable Object is billed for every second it is awake.
import { describe, expect, it } from "vitest";

const sources = import.meta.glob("../src/**/*.ts", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/**
 * Still waiting inside an object, with the spec 44 PR that removes it. Remove the entry with it; a
 * new one needs a reason this short list can't give.
 */
const PENDING: Record<string, string> = {};

const durableObjects = Object.entries(sources).filter(([, text]) =>
  /class \w+ extends DurableObject\b/.test(text),
);

describe("Durable Objects are never held awake (spec 44)", () => {
  it("finds the objects", () => {
    expect(durableObjects.map(([file]) => file)).toEqual(
      expect.arrayContaining(["../src/terminal-relay.ts"]),
    );
  });

  for (const [file, text] of durableObjects) {
    it(`${file}: no timer waits in the object`, () => {
      const code = text.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
      const waits = [...code.matchAll(/\b(setTimeout|setInterval)\s*\(/g)].map((m) => m[1]);
      if (PENDING[file]) {
        expect(waits.length, `${file} no longer waits: drop it from PENDING`).toBeGreaterThan(0);
        return;
      }
      expect(waits).toEqual([]);
    });

    it(`${file}: answers its ping without waking when it accepts sockets`, () => {
      if (!/acceptWebSocket\(/.test(text)) return;
      expect(text).toMatch(/setWebSocketAutoResponse\(/);
    });
  }
});

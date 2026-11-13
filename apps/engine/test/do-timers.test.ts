// Spec 44, criterion 1 (AGENTS.md "Cloudflare cost", rules 5 and 6): no Durable Object keeps a
// setTimeout, a setInterval or a scheduler.wait to wait, in its own file or in a helper it imports
// from src/; every alarm it sets is listed below with why it stops re-arming; and every one that
// accepts sockets answers its ping without waking. A Durable Object is billed for every second it
// is awake.
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

/**
 * Every alarm an object sets, one entry per `setAlarm(` call site in its file, each with why it
 * stops re-arming when there is nothing to do. A new call site fails until it is listed here.
 */
const ALARMS: Record<string, string[]> = {
  "../src/terminal-relay.ts": [
    "the first viewer arms the viewer re-check (VIEWER_RECHECK_MS) when none is set",
    "the re-check re-arms only while a viewer is still connected",
  ],
};

const strip = (text: string) => text.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");

/** Resolves a relative import of `from` (a key of `sources`) to its key, when it is in src/. */
function resolve(from: string, spec: string): string | null {
  const parts = from.split("/").slice(0, -1);
  for (const p of spec.split("/")) {
    if (p === "..") parts.pop();
    else if (p !== ".") parts.push(p);
  }
  const key = parts.join("/");
  return key in sources ? key : null;
}

/** The file and every src/ module it imports, transitively (another Durable Object's file aside). */
function withHelpers(file: string): [string, string][] {
  const seen = new Set<string>([file]);
  const queue = [file];
  while (queue.length > 0) {
    const f = queue.shift() as string;
    for (const m of (sources[f] ?? "").matchAll(/from "(\.\.?\/[^"]+\.ts)"/g)) {
      const key = resolve(f, m[1] as string);
      if (!key || seen.has(key)) continue;
      if (/class \w+ extends DurableObject\b/.test(sources[key] ?? "")) continue;
      seen.add(key);
      queue.push(key);
    }
  }
  return [...seen].map((f): [string, string] => [f, sources[f] ?? ""]);
}

const durableObjects = Object.entries(sources).filter(([, text]) =>
  /class \w+ extends DurableObject\b/.test(text),
);

describe("Durable Objects are never held awake (spec 44)", () => {
  it("finds the objects", () => {
    expect(durableObjects.map(([file]) => file)).toEqual(
      expect.arrayContaining(["../src/terminal-relay.ts", "../src/client-hub.ts"]),
    );
    // Imports are followed, transitively: the relay's invoke() wiring and what it imports.
    expect(withHelpers("../src/terminal-relay.ts").map(([f]) => f)).toContain("../src/deps.ts");
  });

  for (const [file, text] of durableObjects) {
    it(`${file}: no timer waits in the object or the helpers it imports`, () => {
      const waits = withHelpers(file).flatMap(([f, t]) =>
        [...strip(t).matchAll(/\b(setTimeout|setInterval|scheduler\.wait)\s*\(/g)].map(
          (m) => `${f}: ${m[1]}`,
        ),
      );
      if (PENDING[file]) {
        expect(waits.length, `${file} no longer waits: drop it from PENDING`).toBeGreaterThan(0);
        return;
      }
      expect(waits).toEqual([]);
    });

    it(`${file}: every alarm call site is listed with why it stops`, () => {
      const sites = [...strip(text).matchAll(/\bsetAlarm\s*\(/g)].length;
      expect(sites, `${file}: list each setAlarm call in ALARMS with why it stops`).toBe(
        ALARMS[file]?.length ?? 0,
      );
    });

    it(`${file}: answers its ping without waking when it accepts sockets`, () => {
      if (!/acceptWebSocket\(/.test(text)) return;
      expect(text).toMatch(/setWebSocketAutoResponse\(/);
    });
  }
});

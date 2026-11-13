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
const PENDING: Record<string, string> = {
  "../src/planning-hub.ts": "spec 44 PR 3: the website Planning tab's SSE keepalive (setInterval)",
};

/** The alarms objects set, each with why it stops re-arming when there is nothing to do. */
const ALARMS: Record<string, string> = {
  "../src/terminal-relay.ts":
    "re-checks connected viewers every VIEWER_RECHECK_MS; re-armed only while a viewer is connected",
};

const strip = (text: string) => text.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");

/** The file and the src/ helpers it imports directly (`./x.ts`). */
function withHelpers(file: string): [string, string][] {
  const text = sources[file] ?? "";
  const helpers = [...text.matchAll(/from "\.\/([\w-]+\.ts)"/g)]
    .map((m) => `../src/${m[1]}`)
    .filter((f) => f in sources && !/class \w+ extends DurableObject\b/.test(sources[f] ?? ""));
  return [[file, text], ...helpers.map((f): [string, string] => [f, sources[f] ?? ""])];
}

const durableObjects = Object.entries(sources).filter(([, text]) =>
  /class \w+ extends DurableObject\b/.test(text),
);

describe("Durable Objects are never held awake (spec 44)", () => {
  it("finds the objects", () => {
    expect(durableObjects.map(([file]) => file)).toEqual(
      expect.arrayContaining(["../src/terminal-relay.ts", "../src/client-hub.ts"]),
    );
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

    it(`${file}: every alarm it sets is listed with why it stops`, () => {
      const sets = /\bsetAlarm\s*\(/.test(strip(text));
      if (sets) expect(ALARMS[file], `${file} sets an alarm: list it in ALARMS`).toBeTruthy();
    });

    it(`${file}: answers its ping without waking when it accepts sockets`, () => {
      if (!/acceptWebSocket\(/.test(text)) return;
      expect(text).toMatch(/setWebSocketAutoResponse\(/);
    });
  }
});

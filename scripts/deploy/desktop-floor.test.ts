// node --test scripts/deploy/
import assert from "node:assert/strict";
import { test } from "node:test";
import { floorOf, floorProblem, type Published } from "./desktop-floor.ts";

const ch = (
  channel: string,
  manifestVersion: string | null,
  protocol?: number,
  v = manifestVersion,
) =>
  ({
    channel,
    manifestVersion,
    protocol: protocol === undefined ? null : { version: v, protocol },
  }) satisfies Published;

test("no floor needs nothing published", () => {
  assert.equal(floorProblem(0, []), null);
  assert.equal(floorOf('{ "vars": { "DESKTOP_MIN_PROTOCOL": "" } }'), 0);
  assert.equal(floorOf('{ "vars": { "DESKTOP_MIN_PROTOCOL": "2" } // c\n }'), 2);
});

test("a floor above the newest published build's protocol is refused", () => {
  assert.match(
    floorProblem(2, [ch("canary", "0.1.9", 1), ch("stable", null)]) ?? "",
    /above the protocol of the newest canary build/,
  );
  assert.equal(floorProblem(1, [ch("canary", "0.1.9", 1), ch("stable", null)]), null);
});

test("every published channel must speak it", () => {
  assert.match(
    floorProblem(2, [ch("canary", "0.1.9", 2), ch("stable", "1.0.0", 1)]) ?? "",
    /newest stable build/,
  );
});

test("fails closed: nothing published, no protocol file, or one for another version", () => {
  assert.match(floorProblem(1, [ch("canary", null)]) ?? "", /no desktop build is published/);
  assert.match(floorProblem(1, [ch("canary", "0.1.9")]) ?? "", /names no door protocol/);
  assert.match(
    floorProblem(1, [ch("canary", "0.1.9", 1, "0.1.8")]) ?? "",
    /names no door protocol/,
  );
});

// Refuses an engine deploy whose desktop floor would lock everyone out (spec 40 M4, ADR 0393).
//
//   node scripts/deploy/desktop-floor.ts
//
// DESKTOP_MIN_PROTOCOL (apps/engine/wrangler.jsonc, which `wrangler deploy` makes authoritative)
// is the oldest door protocol sf-engine serves. Raised above what the newest published build
// speaks, every app, sign-in included, sees "Update required" with no update to take. So when a
// floor is set, every channel that has published a build must have published one speaking at
// least that protocol: the release workflow writes `<channel>-macos-arm64-protocol.json` after
// each build goes live (apps/desktop/scripts/publish-release.ts). It fails closed: a channel with a
// manifest but no protocol file (or one for another version), or a bucket it can't read, refuses
// the floor. An empty floor (the default) needs no network and always passes.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseJsonc } from "./lib.ts";

export const BASE = "https://downloads.zerobsai.com/desktop";
export const CHANNELS = ["canary", "stable"] as const;

/** What a channel has published: its live manifest's version and its protocol file, or null. */
export interface Published {
  channel: string;
  manifestVersion: string | null;
  protocol: { version?: unknown; protocol?: unknown } | null;
}

/** The floor in sf-engine's config, or 0 when none (empty, 0 or malformed counts as none, as the engine does). */
export function floorOf(wranglerJsonc: string): number {
  const config = parseJsonc(wranglerJsonc) as { vars?: Record<string, unknown> };
  const raw = String(config.vars?.DESKTOP_MIN_PROTOCOL ?? "");
  return /^\d{1,6}$/.test(raw) ? Number(raw) : 0;
}

/** Why `floor` would lock builds out, or null when it is safe. */
export function floorProblem(floor: number, published: Published[]): string | null {
  if (floor <= 0) return null;
  const live = published.filter((p) => p.manifestVersion !== null);
  if (live.length === 0)
    return `DESKTOP_MIN_PROTOCOL=${floor}, but no desktop build is published to speak it`;
  for (const p of live) {
    const doc = p.protocol;
    if (!doc || doc.version !== p.manifestVersion || typeof doc.protocol !== "number")
      return `DESKTOP_MIN_PROTOCOL=${floor}, but ${p.channel} ${p.manifestVersion} names no door protocol: publish a ${p.channel} build first`;
    if (doc.protocol < floor)
      return `DESKTOP_MIN_PROTOCOL=${floor} is above the protocol of the newest ${p.channel} build (${p.manifestVersion} speaks ${doc.protocol}): ship a build that speaks ${floor} first`;
  }
  return null;
}

/** A JSON object from the bucket, null on a real 404; anything else throws (fail closed). */
async function getJson(url: string): Promise<Record<string, unknown> | null> {
  const res = await fetch(url, { headers: { "cache-control": "no-cache" } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

async function main() {
  const floor = floorOf(readFileSync(join("apps", "engine", "wrangler.jsonc"), "utf8"));
  if (floor <= 0) return console.log("desktop floor: none set");
  const published: Published[] = [];
  for (const channel of CHANNELS) {
    const manifest = await getJson(`${BASE}/${channel}-macos-arm64-update-v2.json`);
    const version = typeof manifest?.version === "string" ? manifest.version : null;
    published.push({
      channel,
      manifestVersion: version,
      protocol: version ? await getJson(`${BASE}/${channel}-macos-arm64-protocol.json`) : null,
    });
  }
  const why = floorProblem(floor, published);
  if (why) throw new Error(why);
  console.log(`desktop floor ${floor}: every published channel has a build that speaks it`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`desktop-floor: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}

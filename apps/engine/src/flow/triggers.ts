// The public trigger route (spec 70 milestone 2): `POST /flow/triggers/<pluginId>/<name>?key=<key>`
// runs that plugin's `on.trigger` with the JSON body. The body is capped at 256 KiB.
import { fireTrigger, TRIGGER_BODY_LIMIT } from "@software-factory/plugins";
import { flowHost } from "./door.ts";

export const TRIGGER_PREFIX = "/flow/triggers/";
const ROUTE = /^\/flow\/triggers\/(fplg_[0-9a-f]{32})\/([A-Za-z0-9_.-]{1,64})$/;

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

/** The body as text, or null once it passes the cap (read no further). */
async function readCapped(request: Request): Promise<string | null> {
  if (Number(request.headers.get("content-length") ?? "0") > TRIGGER_BODY_LIMIT) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > TRIGGER_BODY_LIMIT) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    all.set(chunk, at);
    at += chunk.byteLength;
  }
  return new TextDecoder().decode(all);
}

export async function handleTrigger(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return json({ error: "POST only" }, 405);
  const url = new URL(request.url);
  const match = ROUTE.exec(url.pathname);
  if (!match) return json({ error: "Not found" }, 404);
  const [, pluginId = "", name = ""] = match;
  const key = url.searchParams.get("key") ?? "";
  const body = await readCapped(request);
  if (body === null) return json({ error: "The body is over 256 KiB." }, 413);
  let payload: unknown = null;
  if (body.trim()) {
    try {
      payload = JSON.parse(body);
    } catch {
      return json({ error: "The body isn't JSON." }, 400);
    }
  }
  const out = await fireTrigger(flowHost(env), pluginId, name, key, payload);
  return out.ok ? json({ ok: true, created: out.created }) : json({ error: out.error }, out.status);
}

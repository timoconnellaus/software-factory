// A plugin as a Cloudflare Dynamic Worker: its module, wrapped by a small generated entrypoint, is
// loaded through the Worker Loader binding with no network of its own. The loader id is the hash of
// the wrapper and the code, so an edited plugin is a new worker and an unchanged one is reused.
// `ctx` reaches the plugin as an RpcTarget passed with each call (ctx.ts), so the worker's `env` is
// empty and the same worker serves every item.
import {
  type Declaration,
  declarationSchema,
  HOOK_DEADLINE_MS,
  type PluginHostEnv,
} from "./types.ts";

/** The worker's compatibility date: the engine's. */
export const PLUGIN_COMPATIBILITY_DATE = "2026-10-01";

/**
 * The generated main module. It reads the plugin's default export, answers `describe()` with what
 * it declares, and runs one hook with a `ctx` built over the host's RpcTarget. Plain JavaScript: it
 * is a module in the loaded worker, not a file this repository compiles.
 */
export const WRAPPER = `import { WorkerEntrypoint } from "cloudflare:workers";
import * as mod from "./plugin.js";
const HOOKS = ["entered", "leaving", "runEnded", "trigger"];
const TYPES = ["text", "number", "date"];
const plugin = mod.default;
function declaration() {
  if (!plugin || typeof plugin !== "object") {
    throw new Error("The module's default export must be an object: export default { fields, on }.");
  }
  const fields = plugin.fields === undefined ? [] : plugin.fields;
  if (!Array.isArray(fields)) throw new Error("fields must be an array.");
  fields.forEach(function (f, i) {
    if (!f || typeof f.id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(f.id)) {
      throw new Error("fields[" + i + "].id must be letters, digits, _ or - (at most 64).");
    }
    if (typeof f.label !== "string" || !f.label) throw new Error("fields[" + i + "].label must be text.");
    if (!TYPES.includes(f.type)) throw new Error("fields[" + i + "].type must be text, number or date.");
  });
  const on = plugin.on === undefined ? {} : plugin.on;
  if (!on || typeof on !== "object") throw new Error("on must be an object of hooks.");
  const hooks = [];
  for (const key of Object.keys(on)) {
    if (!HOOKS.includes(key)) throw new Error("on." + key + " isn't a hook: use " + HOOKS.join(", ") + ".");
    if (typeof on[key] !== "function") throw new Error("on." + key + " must be a function.");
    hooks.push(key);
  }
  return {
    fields: fields.map(function (f) { return { id: f.id, label: f.label, type: f.type }; }),
    hooks: hooks,
  };
}
function bodyOf(body, headers) {
  if (body === undefined || body === null) return null;
  if (typeof body === "string") return body;
  if (!headers.has("content-type")) headers.set("content-type", "application/json");
  return JSON.stringify(body);
}
function makeCtx(host, item) {
  return {
    item: item === undefined ? null : item,
    comment: function (text) { return host.comment(String(text)); },
    card: function (card) { return host.card(card); },
    setField: function (id, value) { return host.setField(String(id), value === undefined ? null : value); },
    move: function (statusId) { return host.move(String(statusId)); },
    createItem: function (input) { return host.createItem(input); },
    gateway: function (name) {
      return {
        fetch: async function (path, init) {
          init = init || {};
          const headers = new Headers(init.headers || {});
          const body = bodyOf(init.body, headers);
          const r = await host.gatewayFetch(String(name), String(path === undefined ? "" : path), {
            method: init.method || "GET",
            headers: Array.from(headers),
            body: body,
          });
          const empty = [101, 204, 205, 304].includes(r.status);
          return new Response(empty ? null : r.body, { status: r.status, headers: r.headers });
        },
      };
    },
  };
}
export default class extends WorkerEntrypoint {
  describe() {
    return declaration();
  }
  async run(hook, payload, host) {
    const on = plugin && plugin.on;
    const fn = on && on[hook];
    if (typeof fn !== "function") return null;
    const out = await fn.call(on, makeCtx(host, payload.item), payload);
    if (hook !== "leaving" || out === undefined || out === null) return null;
    if (typeof out === "object" && typeof out.refuse === "string" && out.refuse.trim()) {
      return { refuse: out.refuse.trim() };
    }
    throw new Error('leaving must return nothing, or { refuse: "why" }.');
  }
}
`;

/** The plugin worker's entrypoint, as the host calls it. */
export interface PluginEntrypoint {
  describe(): Promise<unknown>;
  run(hook: string, payload: unknown, host: unknown): Promise<{ refuse: string } | null>;
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The loader id: the org, and the hash of the wrapper and the plugin's code. */
export async function loaderId(orgId: string, code: string): Promise<string> {
  return `flow-plugin:${orgId}:${await sha256(`${WRAPPER}\n//--\n${code}`)}`;
}

export class NoLoaderError extends Error {
  constructor() {
    super("This engine has no Worker Loader binding (LOADER), so plugins can't run.");
    this.name = "NoLoaderError";
  }
}

/**
 * The plugin's worker, loaded (or reused) through the Worker Loader, with no outbound network:
 * `globalOutbound: null` makes its own fetch() and connect() throw. It reaches the outside world
 * only through `ctx.gateway`, which the host serves.
 */
export async function loadPlugin(
  env: PluginHostEnv,
  plugin: { orgId: string; code: string },
): Promise<PluginEntrypoint> {
  const loader = env.LOADER;
  if (!loader) throw new NoLoaderError();
  const id = await loaderId(plugin.orgId, plugin.code);
  const worker = loader.get(id, () => ({
    compatibilityDate: PLUGIN_COMPATIBILITY_DATE,
    mainModule: "index.js",
    modules: { "index.js": WRAPPER, "plugin.js": plugin.code },
    env: {},
    globalOutbound: null,
  }));
  // SAFETY: the loaded worker's default export is the wrapper above, whose RPC methods are these;
  // workers-types types the stub as a plain Fetcher.
  return worker.getEntrypoint() as unknown as PluginEntrypoint;
}

/** Runs `work`, or rejects once `ms` have passed. The plugin can't escape it. */
export function withDeadline<T>(work: () => Promise<T>, ms = HOOK_DEADLINE_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`it took longer than ${ms / 1000} seconds`)), ms);
  });
  return Promise.race([Promise.resolve().then(work), expiry]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/** A thrown value as one line of text. */
export function messageOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.trim().slice(0, 2_000) || "it threw without a message";
}

/**
 * Loads `code` as a plugin and reads what it declares: its fields and the hooks it defines.
 * `{ ok: false, error }` when it doesn't load or its default export has the wrong shape.
 */
export async function inspectPlugin(
  env: PluginHostEnv,
  orgId: string,
  code: string,
): Promise<{ ok: true; declaration: Declaration } | { ok: false; error: string }> {
  try {
    const entry = await loadPlugin(env, { orgId, code });
    const declared = await withDeadline(() => entry.describe());
    const parsed = declarationSchema.safeParse(declared);
    if (!parsed.success) return { ok: false, error: parsed.error.message };
    return { ok: true, declaration: parsed.data };
  } catch (error) {
    if (error instanceof NoLoaderError) throw error;
    return { ok: false, error: messageOf(error) };
  }
}

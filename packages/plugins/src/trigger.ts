// Triggers: an outside event for one plugin. The engine's public route
// `POST /flow/triggers/<pluginId>/<name>?key=<key>` lands here; the right key runs that plugin's
// `on.trigger` with the request's JSON body. No signing schemes and no replay protection: the key
// is the whole check (spec 70, keep it simple).
import { getPluginById } from "@software-factory/store";
import { dispatch, Session } from "./dispatch.ts";
import { afterCreated } from "./steps.ts";
import { type PluginHostEnv, type PluginItem, pluginItem } from "./types.ts";

/** The most a trigger's body may be. */
export const TRIGGER_BODY_LIMIT = 256 * 1024;

export type TriggerResult =
  | { ok: true; created: PluginItem[] }
  | { ok: false; status: 403 | 404 | 409 | 500; error: string };

/** Compares in time that doesn't depend on where they first differ. */
function sameKey(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Runs plugin `pluginId`'s `on.trigger` with `name` and `payload`, if `key` is its trigger key. */
export async function fireTrigger(
  env: PluginHostEnv,
  pluginId: string,
  name: string,
  key: string,
  payload: unknown,
): Promise<TriggerResult> {
  const plugin = await getPluginById(env.DB, pluginId);
  if (!plugin) return { ok: false, status: 404, error: "No such plugin." };
  if (!sameKey(key, plugin.triggerKey)) return { ok: false, status: 403, error: "Wrong key." };
  if (!plugin.enabled) return { ok: false, status: 409, error: `Plugin "${plugin.name}" is off.` };
  if (!plugin.hooks.includes("trigger")) {
    return { ok: false, status: 404, error: `Plugin "${plugin.name}" has no on.trigger.` };
  }
  const session = new Session(env);
  const out = await dispatch(
    env,
    plugin.orgId,
    "trigger",
    { name, payload },
    { pluginId, session },
  );
  const created: PluginItem[] = [];
  for (const item of out.created) created.push(pluginItem(await afterCreated(session, item)));
  if (out.failure) return { ok: false, status: 500, error: out.failure.message };
  return { ok: true, created };
}

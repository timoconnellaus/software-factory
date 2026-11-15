// Running one hook in an org's plugins: every enabled plugin that defines it, in name order, each
// in its Dynamic Worker with a 10-second deadline. A throw, a timeout or an invalid return is that
// plugin's failure: its last_error is recorded, the item stops with the error, and nothing after
// it runs. `leaving` ends at the first refusal.
import {
  enabledPlugins,
  type Item,
  type Plugin,
  setPluginLastError,
  stopItem,
} from "@software-factory/store";
import { PluginCtx } from "./ctx.ts";
import type { HookName, HookPayload, PluginHostEnv } from "./types.ts";
import { loadPlugin, messageOf, withDeadline } from "./worker.ts";

/**
 * One request's plugin work: the org's enabled plugins, read once, and the count of plugin moves
 * that followed one another (capped by steps.ts).
 */
export class Session {
  private readonly byOrg = new Map<string, Promise<Plugin[]>>();
  /** Plugin moves applied in this session. */
  moves = 0;

  constructor(readonly env: PluginHostEnv) {}

  plugins(orgId: string): Promise<Plugin[]> {
    let found = this.byOrg.get(orgId);
    if (!found) {
      found = enabledPlugins(this.env.DB, orgId);
      this.byOrg.set(orgId, found);
    }
    return found;
  }
}

export interface DispatchOutcome {
  /** The first `leaving` refusal. */
  refusal?: { plugin: string; reason: string };
  /** A plugin failed; `message` is `Plugin "<name>" failed: <why>`. */
  failure?: { plugin: string; message: string };
  /** The item, stopped, when a plugin failed and the dispatch stopped it. */
  stopped?: Item;
  /** Where the plugins asked to move the item, in order. */
  moves: { plugin: string; to: string }[];
  /** Items the plugins created. */
  created: Item[];
}

export interface DispatchOptions {
  /** The item the hook is about, for `ctx` and for stopping it. */
  item?: Item | null;
  /** The statuses `ctx.move` may name. */
  statusIds?: string[];
  /** Only this plugin (a trigger is for one plugin). */
  pluginId?: string;
  /** False: on a failure, record it but leave the item for the caller to stop. Default true. */
  stop?: boolean;
  session?: Session;
}

/**
 * Runs `hook` in every enabled plugin of `orgId` that defines it, in name order. Plugins that don't
 * define it are never loaded.
 */
export async function dispatch(
  env: PluginHostEnv,
  orgId: string,
  hook: HookName,
  payload: Omit<HookPayload, "hook">,
  options: DispatchOptions = {},
): Promise<DispatchOutcome> {
  const session = options.session ?? new Session(env);
  const plugins = (await session.plugins(orgId)).filter(
    (p) => p.hooks.includes(hook) && (options.pluginId === undefined || p.id === options.pluginId),
  );
  const outcome: DispatchOutcome = { moves: [], created: [] };
  const item = options.item ?? null;
  for (const plugin of plugins) {
    const ctx = new PluginCtx(env, plugin, item, options.statusIds ?? null);
    try {
      const entry = await loadPlugin(env, plugin);
      const out = await withDeadline(() => entry.run(hook, { hook, ...payload }, ctx));
      outcome.moves.push(...ctx.moves.map((to) => ({ plugin: plugin.name, to })));
      outcome.created.push(...ctx.created);
      if (hook === "leaving" && out && typeof out.refuse === "string") {
        outcome.refusal = { plugin: plugin.name, reason: out.refuse };
        return outcome;
      }
    } catch (error) {
      const message = `Plugin "${plugin.name}" failed: ${messageOf(error)}`;
      outcome.created.push(...ctx.created);
      outcome.moves = [];
      outcome.failure = { plugin: plugin.name, message };
      await setPluginLastError(env.DB, plugin.id, message);
      if (item && options.stop !== false) {
        outcome.stopped = await stopItem(env.DB, item.id, message, {
          kind: "plugin",
          id: plugin.name,
        });
      }
      return outcome;
    } finally {
      ctx.closed = true;
    }
  }
  return outcome;
}

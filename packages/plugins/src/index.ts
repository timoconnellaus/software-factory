// @software-factory/plugins: the new core's plugin host (ADR 0660, spec 70 milestone 2). It never
// imports the old core (packages/core).
export { PluginCtx } from "./ctx.ts";
export { type DispatchOptions, type DispatchOutcome, dispatch, Session } from "./dispatch.ts";
export { type GatewayRequest, type GatewayResponse, gatewayFetch, joinUrl } from "./gateway.ts";
export { PLUGIN_GUIDE, savePluginChecked } from "./guide.ts";
export {
  afterCreated,
  applyItemEvent,
  createItemWithHooks,
  endRunWithHooks,
  expireRunsWithHooks,
} from "./steps.ts";
export { fireTrigger, TRIGGER_BODY_LIMIT, type TriggerResult } from "./trigger.ts";
export {
  type Card,
  cardSchema,
  type Declaration,
  HOOK_DEADLINE_MS,
  HOOKS,
  type HookName,
  MOVE_CHAIN_LIMIT,
  type PluginHostEnv,
  type PluginItem,
  PluginRefusal,
  type PluginRun,
  pluginItem,
} from "./types.ts";
export {
  inspectPlugin,
  loaderId,
  loadPlugin,
  NoLoaderError,
  type PluginEntrypoint,
  WRAPPER,
  withDeadline,
} from "./worker.ts";

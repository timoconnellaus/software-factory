// @software-factory/ops: the new core's operations (ADR 0660, spec 70), a thin layer over
// @software-factory/store (and the plugin host, for item events and plugin saves) with one
// permission rule: the caller is a member of the org (or an agent acting in its run's org).
export {
  type CallContext,
  type CallResult,
  call,
  describe,
  describeWithInputs,
  getOperation,
  PREFIX,
} from "./call.ts";
export {
  type AgentCaller,
  type Caller,
  type Ctx,
  defineOperation,
  defineSelfOperation,
  type ErrorCode,
  OpError,
  type Operation,
  type Person,
  type SelfCtx,
} from "./operation.ts";
export { triggerPath } from "./plugins.ts";
export { DUE_PER_TICK, fireSchedule, runDueSchedules } from "./schedules.ts";

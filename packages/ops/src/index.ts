// @software-factory/ops: the new core's operations (ADR 0660, spec 70), a thin layer over
// @software-factory/store with one permission rule: the caller is a member of the org.
export {
  type CallContext,
  type CallResult,
  call,
  describe,
  getOperation,
  PREFIX,
} from "./call.ts";
export {
  type Ctx,
  defineOperation,
  type ErrorCode,
  OpError,
  type Operation,
  type Person,
} from "./operation.ts";

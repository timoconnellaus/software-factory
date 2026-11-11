// The operations RPC (ADR 0051): sf-app (and later the MCP surface) call operations here through a
// service binding to the `EngineApi` entrypoint. The caller authenticates the person and passes the
// actor; this entrypoint is not reachable from the internet.
import { WorkerEntrypoint } from "cloudflare:workers";
import {
  type Actor,
  describeOperations,
  type InvokeResult,
  invoke,
  isOperationError,
  type Origin,
  type Refusal,
  toRefusal,
} from "@software-factory/core";
import { invokeDeps } from "./deps.ts";

export type EngineInvokeResult<O = unknown> =
  | { ok: true; result: InvokeResult<O> }
  | { ok: false; error: Refusal };

export interface EngineInvokeOptions {
  actor: Actor;
  origin: Origin;
  idempotencyKey?: string;
}

export class EngineApi extends WorkerEntrypoint<Env> {
  /**
   * Invoke one operation. Refusals come back as `{ ok: false, error: { code, message } }`, never as
   * a thrown error, because RPC loses error types.
   */
  async invoke(
    name: string,
    input: unknown,
    options: EngineInvokeOptions,
  ): Promise<EngineInvokeResult> {
    try {
      return { ok: true, result: await invoke(invokeDeps(this.env), name, input, options) };
    } catch (error) {
      if (isOperationError(error)) return { ok: false, error: toRefusal(error) };
      throw error;
    }
  }

  /** Every operation with its description, risk, actors and permission (for help and MCP). */
  describeOperations() {
    return describeOperations();
  }
}

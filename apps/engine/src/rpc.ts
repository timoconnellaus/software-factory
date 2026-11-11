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
import { planningHub } from "./planning-hub.ts";

/** `ms` is the time spent inside the engine, so the caller can tell it apart from the hop. */
export type EngineInvokeResult<O = unknown> =
  | { ok: true; result: InvokeResult<O>; ms?: number }
  | { ok: false; error: Refusal; ms?: number };

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
    const start = performance.now();
    const ms = () => Math.round((performance.now() - start) * 10) / 10;
    try {
      const result = await invoke(invokeDeps(this.env), name, input, options);
      return { ok: true, result, ms: ms() };
    } catch (error) {
      if (isOperationError(error)) return { ok: false, error: toRefusal(error), ms: ms() };
      throw error;
    }
  }

  /**
   * A work item's planning changes as Server-Sent Events (spec 20, ADR 0340), for the Planning tab:
   * one `changed` event per change, then the app re-reads `planning.get`. Only for a person who may
   * read the planning view (checked with `planning.get`).
   */
  async planningStream(
    workItemId: string,
    options: EngineInvokeOptions,
  ): Promise<{ ok: true; stream: ReadableStream<Uint8Array> } | { ok: false; error: Refusal }> {
    try {
      await invoke(invokeDeps(this.env), "planning.get", { workItemId }, options);
    } catch (error) {
      if (isOperationError(error)) return { ok: false, error: toRefusal(error) };
      throw error;
    }
    return { ok: true, stream: await planningHub(this.env, workItemId).stream() };
  }

  /** Every operation with its description, risk, actors and permission (for help and MCP). */
  describeOperations() {
    return describeOperations();
  }
}

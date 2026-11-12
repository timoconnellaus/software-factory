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
import {
  parseTerminalPath,
  TERMINAL_PATHS,
  type TerminalMode,
} from "@software-factory/runner-contract";
import { invokeDeps } from "./deps.ts";
import { planningHub } from "./planning-hub.ts";
import { terminalRelay } from "./terminal-relay.ts";

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
   * A work item's planning changes as Server-Sent Events (spec 20, ADR 0350), for the Planning tab:
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

  /**
   * Opens a run's web terminal for a person (spec 35, ADR 0440): `run.terminal.attach` as them
   * (which decides `type` or `watch` and records the attach), then a one-use viewer ticket from the
   * job's relay. The caller opens the socket at `path` through this binding's `fetch`.
   */
  async terminalAttach(
    workItemId: string,
    runId: string,
    options: EngineInvokeOptions,
  ): Promise<
    | { ok: true; jobId: string; mode: TerminalMode; attachId: string; path: string }
    | { ok: false; error: Refusal }
  > {
    const deps = invokeDeps(this.env);
    let attached: { attachId: string; jobId: string; mode: TerminalMode };
    try {
      const result = await invoke(deps, "run.terminal.attach", { workItemId, runId }, options);
      if (result.status !== "ok") {
        return {
          ok: false,
          error: { code: "unavailable", message: "the attach is held for review" },
        };
      }
      attached = result.output as typeof attached;
    } catch (error) {
      if (isOperationError(error)) return { ok: false, error: toRefusal(error) };
      throw error;
    }
    const relay = terminalRelay(this.env, attached.jobId);
    const admitted = await relay.admit({
      attachId: attached.attachId,
      userId: options.actor.id,
      workItemId,
      mode: attached.mode,
    });
    if (!admitted.ok) {
      // Refused for room: the attach closes at once.
      await invoke(
        deps,
        "run.terminal.detach",
        { workItemId, attachId: attached.attachId },
        options,
      ).catch(() => {});
      return { ok: false, error: { code: "conflict", message: admitted.reason } };
    }
    return {
      ok: true,
      jobId: attached.jobId,
      mode: attached.mode,
      attachId: attached.attachId,
      path: `${TERMINAL_PATHS.view(attached.jobId)}?ticket=${admitted.ticket}`,
    };
  }

  /**
   * Only through the service binding: a viewer's web terminal socket (`/terminal/v1/jobs/<id>/view`,
   * with the ticket `terminalAttach` gave), handed to the job's relay. Nothing else.
   */
  override async fetch(request: Request): Promise<Response> {
    const path = parseTerminalPath(new URL(request.url).pathname);
    if (path?.role !== "view") return new Response("Not found", { status: 404 });
    return terminalRelay(this.env, path.jobId).fetch(request);
  }

  /** Every operation with its description, risk, actors and permission (for help and MCP). */
  describeOperations() {
    return describeOperations();
  }
}

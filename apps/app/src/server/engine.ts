// Calls one operation on sf-engine (EngineApi, ADR 0051) as the signed-in person. The actor is
// always the session's user: nothing the browser sends can change it.
import type { Actor, InvokeResult, Origin, Refusal } from "@software-factory/core";
import type { Json, OpResult } from "#/lib/ops";

/** The EngineApi entrypoint as seen through the ENGINE service binding. */
export interface EngineRpc {
  invoke(
    name: string,
    input: unknown,
    options: { actor: Actor; origin: Origin; idempotencyKey?: string },
  ): Promise<
    | { ok: true; result: InvokeResult<unknown>; ms?: number }
    | { ok: false; error: Refusal; ms?: number }
  >;
  /**
   * Opens a run's web terminal for a person (spec 35, ADR 0440): `run.terminal.attach`, then a
   * one-use viewer socket path on the job's relay, opened with `fetch`.
   */
  terminalAttach?(
    workItemId: string,
    runId: string,
    options: { actor: Actor; origin: Origin },
  ): Promise<
    | { ok: true; jobId: string; mode: "type" | "watch"; attachId: string; path: string }
    | { ok: false; error: Refusal }
  >;
  /** The binding's fetch: only the web terminal's viewer socket answers. */
  fetch?(request: Request): Promise<Response>;
}

/** How long one operation took: the whole RPC, and the part spent inside the engine. */
export interface OpTiming {
  name: string;
  ms: number;
  engineMs: number | null;
}

const round = (ms: number) => Math.round(ms * 10) / 10;

export async function invokeAs(
  engine: EngineRpc,
  userId: string,
  name: string,
  input: unknown,
  idempotencyKey?: string,
  timings?: OpTiming[],
): Promise<OpResult> {
  const start = performance.now();
  const response = await engine.invoke(name, input, {
    actor: { type: "human", id: userId },
    origin: { surface: "app", requestId: crypto.randomUUID() },
    ...(idempotencyKey ? { idempotencyKey } : {}),
  });
  timings?.push({ name, ms: round(performance.now() - start), engineMs: response.ms ?? null });
  if (!response.ok)
    return { ok: false, code: response.error.code, message: response.error.message };
  const { result } = response;
  return result.status === "ok"
    ? { ok: true, status: "ok", output: result.output as Json }
    : { ok: true, status: "pending", pendingActionId: result.pendingActionId };
}

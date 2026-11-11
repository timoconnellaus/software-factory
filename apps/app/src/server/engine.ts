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
  ): Promise<{ ok: true; result: InvokeResult<unknown> } | { ok: false; error: Refusal }>;
}

export async function invokeAs(
  engine: EngineRpc,
  userId: string,
  name: string,
  input: unknown,
  idempotencyKey?: string,
): Promise<OpResult> {
  const response = await engine.invoke(name, input, {
    actor: { type: "human", id: userId },
    origin: { surface: "app", requestId: crypto.randomUUID() },
    ...(idempotencyKey ? { idempotencyKey } : {}),
  });
  if (!response.ok)
    return { ok: false, code: response.error.code, message: response.error.message };
  const { result } = response;
  return result.status === "ok"
    ? { ok: true, status: "ok", output: result.output as Json }
    : { ok: true, status: "pending", pendingActionId: result.pendingActionId };
}

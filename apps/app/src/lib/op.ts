// The typed client for operations: `await op("workItem.get", { workItemId })`. Refusals throw an
// OpError with the operation's stable code; a call a gate holds for review returns `pending`.
import { callOperation } from "#/server/fns";
import { OpError, type OpInput, type OpName, type OpOutput } from "./ops.ts";

export async function op<N extends OpName>(
  name: N,
  input: OpInput<N>,
  options: { idempotencyKey?: string } = {},
): Promise<OpOutput<N>> {
  const result = await callOperation({ data: { name, input, ...options } });
  if (!result.ok) {
    if (result.code === "unauthenticated" && typeof window !== "undefined") {
      window.location.assign(`/sign-in?redirect=${encodeURIComponent(window.location.pathname)}`);
    }
    throw new OpError(result.code, result.message);
  }
  if (result.status === "pending") {
    throw new OpError("pending", `held for approval (${result.pendingActionId})`);
  }
  return result.output as OpOutput<N>;
}

/** A fresh key per form submit: a retried submit runs once. */
export const submitKey = () => `app:${crypto.randomUUID()}`;

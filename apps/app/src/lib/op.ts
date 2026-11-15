// The typed client for operations: `await op("cli.deviceLookup", { userCode })`. Refusals throw an
// OpError with the operation's stable code.
import { callOperation } from "#/server/fns";
import { OpError, type OpInput, type OpName, type OpOutput, type OpResult } from "./ops.ts";

export async function op<N extends OpName>(
  name: N,
  input: OpInput<N>,
  options: { idempotencyKey?: string } = {},
): Promise<OpOutput<N>> {
  return unwrap<N>(await callOperation({ data: { name, input, ...options } }));
}

function unwrap<N extends OpName>(result: OpResult): OpOutput<N> {
  if (!result.ok) {
    if (result.code === "unauthenticated" && typeof window !== "undefined") {
      window.location.assign(`/sign-in?redirect=${encodeURIComponent(window.location.pathname)}`);
    }
    throw new OpError(result.code, result.message);
  }
  return result.output as OpOutput<N>;
}

/** A fresh key per form submit: a retried submit runs once. */
export const submitKey = () => `app:${crypto.randomUUID()}`;

// The typed client for operations: `await op("workItem.get", { workItemId })`. Refusals throw an
// OpError with the operation's stable code; a call a gate holds for review returns `pending`.
//
// Reads go through `read()`, which batches: every read asked for in the same tick (a loader's
// `Promise.all` of `ensureQueryData` calls, the parent and child loaders of one navigation) goes
// to the server in one request, resolved against one session, and runs there in parallel.
import { callOperation, callReads } from "#/server/fns";
import {
  OpError,
  type OpInput,
  type OpName,
  type OpOutput,
  type OpResult,
  type ReadOpName,
} from "./ops.ts";

export async function op<N extends OpName>(
  name: N,
  input: OpInput<N>,
  options: { idempotencyKey?: string } = {},
): Promise<OpOutput<N>> {
  return unwrap<N>(await callOperation({ data: { name, input, ...options } }));
}

/** A read operation, batched with the other reads asked for in the same tick (in the browser). */
export function read<N extends ReadOpName>(name: N, input: OpInput<N>): Promise<OpOutput<N>> {
  // On the server every request renders in the same isolate: a shared queue could put two
  // people's reads in one call. Server-side reads run on their own (in-process, no hop to batch).
  if (typeof window === "undefined") {
    return callReads({ data: [{ name, input }] }).then(([r]) => unwrap<N>(r as OpResult));
  }
  return new Promise<OpResult>((resolve, reject) => {
    queue.push({ call: { name, input }, resolve, reject });
    if (queue.length === 1) setTimeout(flush, 0);
  }).then((r) => unwrap<N>(r));
}

/** Most reads in one request (the server's limit). */
const MAX_BATCH = 25;

interface Pending {
  call: { name: ReadOpName; input: unknown };
  resolve: (r: OpResult) => void;
  reject: (e: unknown) => void;
}
let queue: Pending[] = [];

function flush() {
  const batch = queue;
  queue = [];
  for (let i = 0; i < batch.length; i += MAX_BATCH) {
    const chunk = batch.slice(i, i + MAX_BATCH);
    callReads({ data: chunk.map((p) => p.call) }).then(
      (results) => {
        chunk.forEach((p, j) => {
          const r = results[j];
          if (r) p.resolve(r);
          else p.reject(new OpError("unavailable", "no answer for this read"));
        });
      },
      (error) => {
        for (const p of chunk) p.reject(error);
      },
    );
  }
}

function unwrap<N extends OpName>(result: OpResult): OpOutput<N> {
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

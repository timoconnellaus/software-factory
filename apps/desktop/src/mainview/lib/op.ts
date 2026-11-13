// The view's operations (spec 40 M3): every call goes over RPC to the main process, which calls the
// client door with the desktop token. The view never holds a token (ADR 0380).
// - `op` runs one operation (a form submit passes an idempotency key).
// - `read` is batched: every read asked for in the same tick (a loader's `Promise.all`, the parent
//   and child loaders of one navigation) goes in one `batch` call, like sf-app's `read()` (ADR 0241).
// - `decide` is a gate decision: the main process asks for a presence challenge, then Touch ID,
//   then calls with the proof (ADR 0381). Gate decisions never go through `op`.
import { OpError, type OpInput, type OpName, type OpOutput } from "@software-factory/client/ops";
import { DECISION_OPS } from "../../shared/decisions.ts";
import type { AppRPC, CallResult } from "../../shared/rpc.ts";

type Requests = AppRPC["bun"]["requests"];
type Request<K extends keyof Requests> = (
  p: Requests[K]["params"],
) => Promise<Requests[K]["response"]>;

/** The main process's operation requests: main.tsx connects the RPC bridge, tests a fake door. */
export interface OpTransport {
  call: Request<"call">;
  batch: Request<"batch">;
  decide: Request<"decide">;
}
let transport: OpTransport | null = null;
export function connect(t: OpTransport): void {
  transport = t;
}
function bun(): OpTransport {
  if (!transport) throw new Error("the view isn't connected to the main process");
  return transport;
}

export { OpError };

/** The gate decisions, typed: these go through `decide`. */
export type DecisionOp =
  | "spec.approve"
  | "spec.requestChanges"
  | "review.merge"
  | "review.sendBack"
  | "approval.decide"
  | "question.answer"
  | "question.acceptDefaults"
  | "workflow.save"
  | "workflow.createFromTemplate"
  | "workflow.archive"
  | "agent.save"
  | "orgConfig.rollback"
  | "override.approve"
  | "workItem.markRepair";

/** Reads: operations the door's `batch` runs (risk `read`). */
export type ReadOpName =
  | "inbox.list"
  | "org.list"
  | "workItem.previewRouting"
  | "workItem.get"
  | "workItem.list"
  | "workItem.timeline"
  | "workItem.previewAttach"
  | "github.openPullRequests"
  | "workItem.attachment.list"
  | "workItem.attachment.get"
  | "planning.get"
  | "artifact.get"
  | "spec.writeBack"
  | "project.list"
  | "github.repos"
  | "setup.status"
  | "runner.list"
  | "protection.ruleset"
  | "desktopDevice.list"
  | "workItem.board"
  | "config.get"
  | "project.workflow"
  | "mergeQueue.list"
  | "repository.list"
  | "cliToken.list"
  | "config.preview"
  | "config.trials"
  | "config.export"
  | "adjudicator.stats"
  | "workflow.get"
  | "workflow.list"
  | "orgConfig.get"
  | "stageType.list"
  | "workflow.preview"
  | "killSwitch.list"
  | "orgConfig.previewRollback"
  | "incident.listArchiveMissing";

export async function op<N extends Exclude<OpName, DecisionOp>>(
  name: N,
  input: OpInput<N>,
  options: { idempotencyKey?: string } = {},
): Promise<OpOutput<N>> {
  if (DECISION_OPS.has(name)) throw new OpError("forbidden", `${name} goes through decide()`);
  return unwrap<N>(await bun().call({ op: name, input, ...options }));
}

/** A gate decision: Touch ID shows the engine's summary of exactly this call (ADR 0381). */
export async function decide<
  N extends DecisionOp | "planning.answer" | "killSwitch.set" | "orgConfig.adoptProjectWorkflows",
>(name: N, input: OpInput<N>, options: { idempotencyKey?: string } = {}): Promise<OpOutput<N>> {
  return unwrap<N>(await bun().decide({ op: name, input, ...options }));
}

/** The door's limit on one batch. */
const MAX_BATCH = 20;

interface Pending {
  call: { op: ReadOpName; input: unknown };
  resolve: (r: CallResult) => void;
  reject: (e: unknown) => void;
}
let queue: Pending[] = [];

/** A read, batched with the other reads asked for in the same tick. */
export function read<N extends ReadOpName>(name: N, input: OpInput<N>): Promise<OpOutput<N>> {
  return new Promise<CallResult>((resolve, reject) => {
    queue.push({ call: { op: name, input }, resolve, reject });
    if (queue.length === 1) setTimeout(flush, 0);
  }).then((r) => unwrap<N>(r));
}

function flush() {
  const batch = queue;
  queue = [];
  for (let i = 0; i < batch.length; i += MAX_BATCH) {
    const chunk = batch.slice(i, i + MAX_BATCH);
    bun()
      .batch({ calls: chunk.map((p) => p.call) })
      .then(
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

function unwrap<N extends OpName>(r: CallResult): OpOutput<N> {
  if (!r.ok) throw new OpError(r.code, r.error);
  return r.result as OpOutput<N>;
}

/** A fresh key per form submit: a retried submit runs once. */
export const submitKey = () => `desktop:${crypto.randomUUID()}`;

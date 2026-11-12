// The main process's operation requests from the view (spec 40 M3): `call`, `batch` and `decide`
// over the client door. Apart from Electrobun so tests drive the same code against a fake door.
// - A gate decision arriving through `call` is refused: it needs `decide` (ADR 0381).
// - `decide` signs with the device key; Touch ID is the key's own prompt (sf-keys).
// - A revoked token turns into "signed out" (`signedOut`), not an error.
import { DECISION_OPS, refuseDecisionCall } from "../shared/decisions.ts";
import type { CallResult } from "../shared/rpc.ts";
import { type Door, type Signer, UnauthenticatedError } from "./door.ts";

const SIGNED_OUT: CallResult = { ok: false, code: "unauthenticated", error: "signed out" };

export function operationHandlers(deps: {
  door: () => Door;
  /** The device key's signer, or null when this Mac has none (signed out). */
  signer: () => Signer | null;
  signedOut: () => void;
}) {
  /** A door call that turns a revoked token into "signed out" instead of an error. */
  async function guarded<T extends CallResult | CallResult[]>(
    f: () => Promise<T>,
    fallback: T,
  ): Promise<T> {
    try {
      return await f();
    } catch (error) {
      if (error instanceof UnauthenticatedError) {
        deps.signedOut();
        return fallback;
      }
      const message = error instanceof Error ? error.message : "network error";
      const unavailable: CallResult = { ok: false, code: "unavailable", error: message };
      return (Array.isArray(fallback) ? fallback.map(() => unavailable) : unavailable) as T;
    }
  }

  return {
    guarded,
    async call({
      op,
      input,
      idempotencyKey,
    }: {
      op: string;
      input: unknown;
      idempotencyKey?: string;
    }): Promise<CallResult> {
      if (DECISION_OPS.has(op)) return refuseDecisionCall(op);
      return guarded<CallResult>(
        () => deps.door().call(op, input, idempotencyKey ? { idempotencyKey } : {}),
        SIGNED_OUT,
      );
    },
    batch({ calls }: { calls: { op: string; input: unknown }[] }): Promise<CallResult[]> {
      return guarded(
        () => deps.door().batch(calls),
        calls.map(() => SIGNED_OUT),
      );
    },
    async decide({
      op,
      input,
      idempotencyKey,
    }: {
      op: string;
      input: unknown;
      idempotencyKey?: string;
    }): Promise<CallResult> {
      const sign = deps.signer();
      if (!sign) {
        return {
          ok: false,
          code: "unauthenticated",
          error: "sign in again: this Mac has no device key",
        };
      }
      if (!DECISION_OPS.has(op)) {
        return { ok: false, code: "invalid_input", error: `${op} isn't a gate decision` };
      }
      return guarded(() => deps.door().decide(op, input, sign, idempotencyKey), SIGNED_OUT);
    },
  };
}

// The desktop app's client for sf-engine's client door (/client/v1, ADR 0391). Lives in the main
// process only: the token never reaches the webview.
import type { CallResult } from "../shared/rpc.ts";
import { inputDigest, presenceMessage } from "./digest.ts";
import { PROTOCOL_HEADERS, UpdateRequiredError } from "./protocol.ts";

export type Fetch = (input: string, init: RequestInit) => Promise<Response>;
/**
 * Signs a presence message with the device key. Asking for Touch ID is the OS's job, and the prompt
 * shows the message's own summary line (ADR 0391): nothing the caller says.
 */
export type Signer = (message: string) => Promise<string>;

export class UnauthenticatedError extends Error {}

export class Door {
  constructor(
    readonly baseUrl: string,
    private readonly token: () => string | null,
    private readonly fetchImpl: Fetch = fetch,
    /** The door refused this build as too old (ADR 0393): check for an update now. */
    private readonly onUpdateRequired?: () => void,
  ) {}

  private async post(
    path: string,
    body: unknown,
    auth = true,
  ): Promise<{ status: number; json: Record<string, unknown> }> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      ...PROTOCOL_HEADERS,
    };
    if (auth) {
      const t = this.token();
      if (!t) throw new UnauthenticatedError("not signed in");
      headers.authorization = `Bearer ${t}`;
    }
    const res = await this.fetchImpl(`${this.baseUrl.replace(/\/+$/, "")}/client/v1/${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    if (res.status === 401)
      throw new UnauthenticatedError("the desktop token expired or was revoked");
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.status === 426 && json.code === "update_required") {
      this.onUpdateRequired?.();
      throw new UpdateRequiredError(String(json.error ?? "this version of the app is too old"));
    }
    return { status: res.status, json };
  }

  /** The two unsigned sign-in calls answer with the operation's output itself. */
  async signInCall<T>(path: "desktop/start" | "desktop/exchange", body: unknown): Promise<T> {
    const { status, json } = await this.post(path, body, false);
    if (status !== 200) throw new Error(String(json.error ?? `sign-in failed (${status})`));
    return json as T;
  }

  /**
   * One operation. A form submit passes an idempotency key so a retry runs once. A call a gate holds
   * for review answers `pending` (the door's 202), which the view shows as not done yet.
   */
  async call(
    op: string,
    input: unknown,
    options: { presence?: unknown; idempotencyKey?: string } = {},
  ): Promise<CallResult> {
    const { presence, idempotencyKey } = options;
    const { status, json } = await this.post("call", {
      op,
      input,
      ...(presence ? { presence } : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });
    if (status === 202 && json.pending) {
      return {
        ok: false,
        code: "pending",
        error: `held for approval (${String(json.pendingActionId ?? "")})`,
      };
    }
    return "result" in json
      ? { ok: true, result: json.result }
      : { ok: false, code: String(json.code ?? "failed"), error: String(json.error ?? "failed") };
  }

  async batch(calls: { op: string; input: unknown }[]): Promise<CallResult[]> {
    const { json } = await this.post("batch", { calls });
    const results = (json.results ?? []) as {
      ok: boolean;
      result?: unknown;
      code?: string;
      error?: string;
    }[];
    return results.map((r) =>
      r.ok
        ? { ok: true, result: r.result }
        : { ok: false, code: r.code ?? "failed", error: r.error ?? "failed" },
    );
  }

  /**
   * A gate decision (ADR 0391): a one-time challenge for this op and input, with the engine's
   * summary of the decision, signed (Touch ID shows the summary), then the call with the proof.
   */
  async decide(
    op: string,
    input: unknown,
    sign: Signer,
    idempotencyKey?: string,
  ): Promise<CallResult> {
    const digest = await inputDigest(input);
    const challenge = await this.call("presence.challenge", { op, input });
    if (!challenge.ok) return challenge;
    const c = challenge.result as {
      challengeId: string;
      nonce: string;
      inputDigest: string;
      summary: string;
    };
    // The engine digests the input it was sent; it must be the one this call sends.
    if (c.inputDigest !== digest) {
      return { ok: false, code: "conflict", error: "the engine digested a different input" };
    }
    let signature: string;
    try {
      signature = await sign(presenceMessage(c.nonce, op, digest, c.summary));
    } catch (error) {
      // The key helper's own reason when it gives one (busy, cancelled, expired, auth_failed…,
      // device-key.ts); nothing is decided either way.
      const code = (error as { code?: unknown } | null)?.code;
      return {
        ok: false,
        code: typeof code === "string" ? code : "cancelled",
        error: error instanceof Error ? error.message : "Touch ID was cancelled",
      };
    }
    return this.call(op, input, {
      presence: { challengeId: c.challengeId, nonce: c.nonce, signature },
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });
  }
}

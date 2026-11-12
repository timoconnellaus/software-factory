// The desktop app's client for sf-engine's client door (/client/v1, ADR 0391). Lives in the main
// process only: the token never reaches the webview.
import type { CallResult } from "../shared/rpc.ts";
import { inputDigest, presenceMessage } from "./digest.ts";

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
  ) {}

  private async post(
    path: string,
    body: unknown,
    auth = true,
  ): Promise<{ status: number; json: Record<string, unknown> }> {
    const headers: Record<string, string> = { "content-type": "application/json" };
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
    return { status: res.status, json };
  }

  /** The two unsigned sign-in calls answer with the operation's output itself. */
  async signInCall<T>(path: "desktop/start" | "desktop/exchange", body: unknown): Promise<T> {
    const { status, json } = await this.post(path, body, false);
    if (status !== 200) throw new Error(String(json.error ?? `sign-in failed (${status})`));
    return json as T;
  }

  async call(op: string, input: unknown, presence?: unknown): Promise<CallResult> {
    const { json } = await this.post("call", { op, input, ...(presence ? { presence } : {}) });
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
  async decide(op: string, input: unknown, sign: Signer): Promise<CallResult> {
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
      return {
        ok: false,
        code: "cancelled",
        error: error instanceof Error ? error.message : "Touch ID was cancelled",
      };
    }
    return this.call(op, input, { challengeId: c.challengeId, nonce: c.nonce, signature });
  }
}

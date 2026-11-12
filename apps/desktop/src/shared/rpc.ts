// The RPC between the Bun main process and the webview (ADR 0390). The view never holds the desktop
// token: it asks the main process to call operations, and to decide gates (which asks for Touch ID).
// No message or response here carries a token, a nonce or a key (test/rpc.test.ts checks).

export type RunnerStatus =
  | "unpaired"
  | "launchd"
  | "stopped"
  | "starting"
  | "running"
  | "restarting"
  | "locked"
  | "failed";

export interface RunnerState {
  status: RunnerStatus;
  pid: number | null;
  restarts: number;
  lastLine: string | null;
}

export interface Session {
  signedIn: boolean;
  login: string | null;
  deviceId: string | null;
  keyStorage: "secure-enclave" | "software" | null;
  signingIn: boolean;
  error: string | null;
}

/**
 * An operation's answer as the view sees it: the door's `{ result }` or `{ code, error }`. A call a
 * gate holds is `{ ok: false, code: "pending" }`. Bytes travel as `{ $bytes: base64 }` both ways.
 */
export type CallResult = { ok: true; result: unknown } | { ok: false; code: string; error: string };

/**
 * What a run's web terminal socket did (spec 42, ADR 0500), relayed by the main process: the relay's
 * JSON messages as `text`, the pane's output bytes as base64. The view chose the handle (`id`).
 */
export type TerminalEvent =
  | { id: string; kind: "open" }
  | { id: string; kind: "text"; data: string }
  | { id: string; kind: "bytes"; base64: string }
  | { id: string; kind: "close"; code: number; reason: string };

export type AppRPC = {
  bun: {
    requests: {
      session: { params: Record<string, never>; response: Session };
      signIn: { params: Record<string, never>; response: Session };
      signOut: { params: Record<string, never>; response: Session };
      /** One operation; a form submit passes an idempotency key so a retry runs once. */
      call: {
        params: { op: string; input: unknown; idempotencyKey?: string };
        response: CallResult;
      };
      batch: { params: { calls: { op: string; input: unknown }[] }; response: CallResult[] };
      /** A gate decision: a presence challenge, Touch ID (showing the engine's summary), then the call (ADR 0391). */
      decide: {
        params: { op: string; input: unknown; idempotencyKey?: string };
        response: CallResult;
      };
      runnerState: { params: Record<string, never>; response: RunnerState };
      runnerAction: {
        params: { action: "pair" | "takeover" | "restart" };
        response: RunnerState;
      };
      loginItem: { params: { enable?: boolean }; response: { enabled: boolean } };
      openExternal: { params: { url: string }; response: { ok: boolean } };
      /** Opens a run's web terminal through the client door under the view's handle (spec 42). */
      terminalOpen: {
        params: { id: string; workItemId: string; runId: string };
        response: { ok: boolean; error: string | null };
      };
      /** One text frame to the relay (keys or a size, as the shared client writes them). */
      terminalSend: { params: { id: string; data: string }; response: { ok: boolean } };
      terminalClose: { params: { id: string }; response: { ok: boolean } };
      /** Saves a file to ~/Downloads (base64 bytes) and shows it in Finder. */
      saveDownload: {
        params: { filename: string; base64: string };
        response: { ok: boolean; path: string | null };
      };
    };
    messages: Record<string, never>;
  };
  webview: {
    requests: Record<string, never>;
    messages: {
      sessionChanged: Session;
      runnerChanged: RunnerState;
      inboxChanged: { count: number };
      navigate: { path: string };
      terminalEvent: TerminalEvent;
    };
  };
};

// The RPC between the Bun main process and the webview (ADR 0370). The view never holds the desktop
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

/** An operation's answer as the view sees it: the door's `{ result }` or `{ code, error }`. */
export type CallResult = { ok: true; result: unknown } | { ok: false; code: string; error: string };

export type AppRPC = {
  bun: {
    requests: {
      session: { params: Record<string, never>; response: Session };
      signIn: { params: Record<string, never>; response: Session };
      signOut: { params: Record<string, never>; response: Session };
      call: { params: { op: string; input: unknown }; response: CallResult };
      batch: { params: { calls: { op: string; input: unknown }[] }; response: CallResult[] };
      /** A gate decision: a presence challenge, Touch ID, then the call (ADR 0371). */
      decide: { params: { op: string; input: unknown; reason: string }; response: CallResult };
      runnerState: { params: Record<string, never>; response: RunnerState };
      runnerAction: {
        params: { action: "pair" | "takeover" | "restart" };
        response: RunnerState;
      };
      loginItem: { params: { enable?: boolean }; response: { enabled: boolean } };
      openExternal: { params: { url: string }; response: { ok: boolean } };
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
    };
  };
};

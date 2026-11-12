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
 * Updates as the view sees them (spec 40 M4, ADR 0393). `required`: the door refused this build as
 * too old (426 update_required), so nothing but updating works; the view shows its "Update
 * required" screen. `ready`: a verified update is staged. `jobs`: how many jobs the runner is
 * running (restarting cancels them, so the view asks first). `downloadUrl`: the channel's download,
 * for when nothing is staged.
 */
export interface UpdateStatus {
  required: boolean;
  ready: boolean;
  version: string | null;
  error: string | null;
  needsMove: boolean;
  jobs: number;
  downloadUrl: string;
}

/**
 * An operation's answer as the view sees it: the door's `{ result }` or `{ code, error }`. A call a
 * gate holds is `{ ok: false, code: "pending" }`. Bytes travel as `{ $bytes: base64 }` both ways.
 */
export type CallResult = { ok: true; result: unknown } | { ok: false; code: string; error: string };

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
      /** A double-click on the toolbar's empty space: the system's title-bar action (spec 41). */
      titleBarDoubleClick: {
        params: Record<string, never>;
        response: { action: "zoom" | "minimize" | "none" };
      };
      /** Saves a file to ~/Downloads (base64 bytes) and shows it in Finder. */
      saveDownload: {
        params: { filename: string; base64: string };
        response: { ok: boolean; path: string | null };
      };
      updateStatus: { params: Record<string, never>; response: UpdateStatus };
      /**
       * restart: only while the runner is idle. restart-when-idle: once its jobs end.
       * restart-anyway: cancels its jobs (the view named them). download: opens the download.
       * retry: forget update_required and try the door again (the floor may have been lowered).
       */
      updateAction: {
        params: {
          action: "restart" | "restart-when-idle" | "restart-anyway" | "download" | "retry";
        };
        response: UpdateStatus;
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
      updateChanged: UpdateStatus;
    };
  };
};

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
  /**
   * While signing in: the new device key's fingerprint, which the website's approval page shows
   * too. The person approves only when they match (spec 40 M4b).
   */
  keyFingerprint: string | null;
  /**
   * This Mac has a software key but its build has a working key helper: it can keep its key in the
   * Secure Enclave by signing in again (spec 40 M4b, migration).
   */
  keyUpgrade: boolean;
}

/**
 * Updates as the view sees them (spec 40 M4, ADR 0393). `required`: the door refused this build as
 * too old (426 update_required), so nothing but updating works; the view shows its "Update
 * required" screen. `ready`: a verified update is staged. `jobs`: how many jobs the runner is
 * running (restarting cancels them, so the view asks first). `waitingForRunner`: "Restart to update"
 * is waiting for the runner to stop claiming (it gives up at this time, epoch ms), or null.
 * `downloadUrl`: the channel's download, for when nothing is staged.
 */
export interface UpdateStatus {
  required: boolean;
  ready: boolean;
  version: string | null;
  error: string | null;
  needsMove: boolean;
  jobs: number;
  waitingForRunner: number | null;
  downloadUrl: string;
  /** Check for updates (Settings > This Mac, the menus): where the latest check is or what it found. */
  phase: CheckPhase;
  /** When a check last finished (epoch ms), or null. */
  checkedAt: number | null;
  /** This build's version and channel, once read. */
  installed: string | null;
  channel: string | null;
  /** Why the last check failed, or why this build takes no updates, in plain words. */
  reason: string | null;
  /** The last update didn't install (read after the relaunch): shown with Retry, not as new. */
  installFailure?: { version: string; reason: string } | null;
}

/**
 * idle: not checked yet. checking, downloading: a check is running. up-to-date, ready, failed:
 * what the last one found. off: this build takes no updates (a dev or unsigned build).
 */
export type CheckPhase =
  | "idle"
  | "checking"
  | "downloading"
  | "up-to-date"
  | "ready"
  | "failed"
  | "off";

/**
 * An operation's answer as the view sees it: the door's `{ result }` or `{ code, error }`. A call a
 * gate holds is `{ ok: false, code: "pending" }`. Bytes travel as `{ $bytes: base64 }` both ways.
 */
export type CallResult = { ok: true; result: unknown } | { ok: false; code: string; error: string };

/**
 * What a run's web terminal socket did (spec 42, ADR 0530), relayed by the main process: the relay's
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
      /** Sign out and straight back in, making a Secure Enclave key (spec 40 M4b, migration). */
      signInAgain: { params: Record<string, never>; response: Session };
      /** The person cancelled the decision waiting for Touch ID: the sheet goes away. */
      cancelTouchId: { params: Record<string, never>; response: { cancelled: boolean } };
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
       * check: a person asked to check for updates now (not rate-limited; joins one running).
       */
      updateAction: {
        params: {
          action:
            | "restart"
            | "restart-when-idle"
            | "restart-anyway"
            | "download"
            | "retry"
            | "check";
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
      /** A decision is waiting for Touch ID (its summary, the sheet's words), or none is (null). */
      touchIdChanged: { summary: string | null };
      runnerChanged: RunnerState;
      inboxChanged: { count: number };
      planningChanged: { workItemId: string };
      navigate: { path: string };
      updateChanged: UpdateStatus;
      terminalEvent: TerminalEvent;
    };
  };
};

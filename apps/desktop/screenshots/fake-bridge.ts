// The screenshot harness's stand-in for src/mainview/bridge.ts (ADR 0460): the same exports, but
// operations are answered from fixtures.ts instead of the main process. vite.config.ts swaps it in.
// It also draws the traffic lights macOS would draw over the toolbar, so shots match the window.
import type { OpName } from "@software-factory/client/ops";
import type {
  AppRPC,
  CallResult,
  RunnerState,
  Session,
  TerminalEvent,
  UpdateStatus,
} from "../src/shared/rpc.ts";
import { ANSWERS, Refusal } from "./fixtures.ts";

/**
 * Loaded in the real window (a dev build's SF_VIEW_URL) rather than headless Chrome: Electrobun's
 * preload has given the page its window id.
 */
const inWindow =
  typeof (window as { __electrobunWindowId?: unknown }).__electrobunWindowId === "number";

/**
 * In the real window the title-bar double-click still goes to the main process, so the zoom can be
 * checked; operations stay on fixtures. Headless Chrome has no main process: nothing happens.
 */
let windowRpc: Promise<((method: string) => Promise<unknown>) | null> | null = null;
function mainProcess() {
  windowRpc ??= inWindow
    ? import("electrobun/view").then(({ Electroview }) => {
        const rpc = Electroview.defineRPC<AppRPC>({
          maxRequestTime: 10_000,
          handlers: { requests: {}, messages: {} },
        });
        const view = new Electroview({ rpc });
        // biome-ignore lint/suspicious/noExplicitAny: Electroview's request function is loosely typed.
        return (method: string) => (view.rpc as any).request(method, {});
      })
    : Promise.resolve(null);
  return windowRpc;
}

const session: Session = {
  signedIn: true,
  login: "owner",
  deviceId: "dev_m5",
  // `?key=software` (before the hash): a released build before the key helper (ADR 0610).
  keyStorage:
    new URLSearchParams(location.search).get("key") === "software" ? "software" : "secure-enclave",
  signingIn: false,
  error: null,
  keyFingerprint: null,
  keyUpgrade: false,
};
/**
 * The device key's screens (spec 40 M4b), from `?key=` before the hash: `signing-in` (signed out,
 * waiting for the browser, the new key's fingerprint shown), `upgrade` (a software key on a build
 * with the key helper: the offer to sign in again), `touch-id` (a decision waiting for Touch ID).
 */
const KEY_FIXTURE = new URLSearchParams(location.search).get("key");
if (KEY_FIXTURE === "signing-in")
  Object.assign(session, {
    signedIn: false,
    login: null,
    deviceId: null,
    signingIn: true,
    keyFingerprint: "3f2a-91c0-77be-d41e",
  });
if (KEY_FIXTURE === "upgrade") Object.assign(session, { keyStorage: "software", keyUpgrade: true });

/**
 * Signing in and out as the main process does it (the behaviour tests): `?session=out` starts
 * signed out, and every read answers "signed out" as the main process's door does then.
 * `window.__sfSignIn()` completes a sign-in (the device approved in the browser) and
 * `window.__sfRevoke()` ends the token mid-session (the device replaced): each pushes the session.
 * `?crash=1` makes the shell's first read fail with an unexpected error (the root error screen).
 */
const SESSION_FIXTURE = new URLSearchParams(location.search).get("session");
const CRASH = new URLSearchParams(location.search).get("crash") === "1";
const SIGNED_IN = { ...session };
const SIGNED_OUT_SESSION = {
  signedIn: false,
  login: null,
  deviceId: null,
  signingIn: false,
  keyFingerprint: null,
};
if (SESSION_FIXTURE === "out") Object.assign(session, SIGNED_OUT_SESSION);
const sessionListeners = new Set<(s: Session) => void>();
const pushSession = () => {
  for (const l of sessionListeners) l({ ...session });
};
Object.assign(window, {
  __sfSignIn: () => {
    Object.assign(session, SIGNED_IN);
    pushSession();
  },
  __sfRevoke: () => {
    Object.assign(session, SIGNED_OUT_SESSION);
    pushSession();
  },
});
const SIGNED_OUT: CallResult = { ok: false, code: "unauthenticated", error: "signed out" };
// The open item's merge (#13), worded as the engine writes it (describeDecision).
const TOUCH_ID_SUMMARY =
  'Merge 3f2a91c into main of example/software-factory: "Guard the tests in verify"';
const runner: RunnerState = { status: "running", pid: 4242, restarts: 0, lastLine: null };

/**
 * Updates (ADR 0393): a page loaded with `?update=ready|jobs|download` (before the hash) shows the
 * Update required screen in that state; anything else is a current build.
 */
function updateStatus(): UpdateStatus {
  const which = new URLSearchParams(location.search).get("update");
  return {
    required: !!which,
    ready: which === "ready" || which === "jobs" || which === "waiting",
    version: which === "ready" || which === "jobs" || which === "waiting" ? "0.1.42" : null,
    error: which === "download" ? "Failed to download update: HTTP 404" : null,
    needsMove: false,
    jobs: which === "jobs" ? 2 : 0,
    waitingForRunner: which === "waiting" ? Date.now() + 25_000 : null,
    downloadUrl: "https://downloads.zerobsai.com/desktop/canary-macos-arm64-Software-Factory.zip",
    // The Update required screens keep their own state; Settings' check row reads `?check=`.
    ...(which
      ? { phase: "idle", checkedAt: null, installed: "0.1.41", channel: "canary", reason: null }
      : checkState()),
  };
}

/**
 * Check for updates in Settings > This Mac (spec 40 M4): `?check=<state>` shows the row in that
 * state (idle, checking, up-to-date, downloading, ready, jobs, failed, offline, refused, off);
 * anything else is up to date, checked 12 minutes ago.
 */
function checkState(): Pick<
  UpdateStatus,
  | "phase"
  | "checkedAt"
  | "installed"
  | "channel"
  | "reason"
  | "ready"
  | "version"
  | "jobs"
  | "installFailure"
> {
  const which = new URLSearchParams(location.search).get("check") ?? "up-to-date";
  const at = Date.now() - 12 * 60_000;
  const base = { installed: "0.1.41", channel: "canary", checkedAt: at, reason: null };
  const offline =
    "Couldn't reach the update server. Check that this Mac is online, then try again.";
  switch (which) {
    case "idle":
      return { ...base, phase: "idle", checkedAt: null, ready: false, version: null, jobs: 0 };
    case "checking":
      return { ...base, phase: "checking", ready: false, version: null, jobs: 0 };
    case "downloading":
      return { ...base, phase: "downloading", ready: false, version: "0.1.42", jobs: 0 };
    case "ready":
      return { ...base, phase: "ready", ready: true, version: "0.1.42", jobs: 0 };
    case "jobs":
      return { ...base, phase: "ready", ready: true, version: "0.1.42", jobs: 2 };
    // The last restart relaunched the old version (Electrobun's helper refused it).
    case "not-installed":
      return {
        ...base,
        phase: "ready",
        ready: true,
        version: "0.1.42",
        jobs: 0,
        installFailure: {
          version: "0.1.42",
          reason:
            "The update to 0.1.42 didn't install: the updater's record of where the app is installed named another copy (the app was moved after it was first opened).",
        },
      };
    case "offline":
      return { ...base, phase: "failed", ready: false, version: null, jobs: 0, reason: offline };
    case "refused":
      return {
        ...base,
        phase: "failed",
        ready: false,
        version: "0.1.42",
        jobs: 0,
        reason: "Version 0.1.42 was refused: its signature didn't check out.",
      };
    case "off":
      return {
        ...base,
        channel: "dev",
        installed: "0.0.1",
        phase: "off",
        checkedAt: null,
        ready: false,
        version: null,
        jobs: 0,
        reason: "Updates are off in this build (a development build).",
      };
    default:
      return { ...base, phase: "up-to-date", ready: false, version: null, jobs: 0 };
  }
}

function answer(op: string, input: unknown): CallResult {
  if (!session.signedIn) return SIGNED_OUT;
  if (CRASH && op === "org.list")
    return { ok: false, code: "unavailable", error: "the door answered 502 Bad Gateway" };
  const f = ANSWERS[op as OpName] as ((i: unknown) => unknown) | undefined;
  if (!f) return { ok: false, code: "unavailable", error: `no fixture for ${op}` };
  try {
    return { ok: true, result: f(input) };
  } catch (e) {
    if (e instanceof Refusal) return { ok: false, code: e.code, error: e.message } as CallResult;
    throw e;
  }
}

/** The writes the view made, in order, for the behaviour tests (behave.mjs) to check. */
const calls: { op: string; input: unknown }[] = [];
(window as { __sfCalls?: typeof calls }).__sfCalls = calls;
/** A write takes a moment, as over the door, so a second click can land while one runs. */
async function write(p: { op: string; input: unknown }): Promise<CallResult> {
  calls.push(p);
  await new Promise((r) => setTimeout(r, 400));
  return answer(p.op, p.input);
}

export const bun = {
  session: async () => ({ ...session }),
  signIn: async () => ({ ...session }),
  signOut: async () => session,
  signInAgain: async () => session,
  cancelTouchId: async () => ({ cancelled: true }),
  call: (p: { op: string; input: unknown }) => write(p),
  batch: async (p: { calls: { op: string; input: unknown }[] }) =>
    p.calls.map((c) => answer(c.op, c.input)),
  decide: async (p: { op: string; input: unknown }) => answer(p.op, p.input),
  runnerState: async () => runner,
  runnerAction: async () => runner,
  loginItem: async () => ({ enabled: true }),
  openExternal: async () => ({ ok: true }),
  saveDownload: async () => ({ ok: true, path: null }),
  updateStatus: async () => updateStatus(),
  updateAction: async () => updateStatus(),
  // A run's terminal (spec 42): the harness's server bridges a real tmux pane it was given
  // (terminal.mjs); without one, opening it fails as an unreachable terminal does.
  terminalOpen: async (p: { id: string; workItemId: string; runId: string }) => {
    if (FIXTURE_TERMINAL) return fixtureOpen(p);
    await subscribed();
    return post<{ ok: boolean; error: string | null }>("open", { ...p, mode: TERMINAL_MODE });
  },
  terminalSend: (p: { id: string; data: string }) =>
    FIXTURE_TERMINAL ? Promise.resolve({ ok: true }) : post<{ ok: boolean }>("send", p),
  terminalClose: (p: { id: string }) =>
    FIXTURE_TERMINAL ? fixtureClose(p) : post<{ ok: boolean }>("close", p),
  titleBarDoubleClick: async () => {
    const call = await mainProcess();
    return call
      ? ((await call("titleBarDoubleClick")) as { action: "zoom" | "minimize" | "none" })
      : { action: "none" as const };
  },
};

const none = () => () => undefined;

const TERMINAL_MODE = new URLSearchParams(location.search).get("terminal") ?? "type";
async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`/__terminal/${path}`, { method: "POST", body: JSON.stringify(body) });
  return (await res.json()) as T;
}
const terminalListeners = new Set<(e: TerminalEvent) => void>();

/**
 * `?terminal=fixture`: a made-up session instead of a real tmux pane, so screenshots never show
 * the Mac's own shell, and the behaviour tests can see a terminal open and its socket released
 * (each open and close is recorded with the writes).
 */
const FIXTURE_TERMINAL = TERMINAL_MODE === "fixture";
const FIXTURE_SCREEN = [
  "\x1b[32mrunner\x1b[0m job-9 % claude",
  "",
  "\x1b[1m> Task 2 of 4: record suppressions on the review packet\x1b[0m",
  "",
  "\x1b[34m●\x1b[0m Read(packages/core/src/verify/suppressions.ts)",
  "\x1b[34m●\x1b[0m Edit(packages/core/test/packet.test.ts)",
  "\x1b[34m●\x1b[0m Bash(pnpm test --filter core)",
  "  ⎿  \x1b[31m1 failing\x1b[0m: the packet shows the new section",
  "",
  "\x1b[34m●\x1b[0m The fixture still has the old section name. Fixing it.",
  "",
  "\x1b[2m  ⏵⏵ accept edits on · esc to interrupt\x1b[0m",
].join("\r\n");
const emitTerminal = (e: TerminalEvent) => {
  for (const f of terminalListeners) f(e);
};
function fixtureOpen(p: { id: string; workItemId: string; runId: string }) {
  calls.push({ op: "terminal.open", input: p });
  setTimeout(() => {
    emitTerminal({ id: p.id, kind: "open" });
    emitTerminal({
      id: p.id,
      kind: "text",
      data: JSON.stringify({ t: "hello", mode: "type", viewers: 1, host: true }),
    });
    const bytes = new TextEncoder().encode(FIXTURE_SCREEN);
    emitTerminal({ id: p.id, kind: "bytes", base64: btoa(String.fromCharCode(...bytes)) });
  }, 50);
  return Promise.resolve({ ok: true, error: null });
}
function fixtureClose(p: { id: string }) {
  calls.push({ op: "terminal.close", input: p });
  setTimeout(() => emitTerminal({ id: p.id, kind: "close", code: 1000, reason: "" }), 0);
  return Promise.resolve({ ok: true });
}
let events: Promise<void> | null = null;
/** The harness's event stream, open before a terminal is (so its first frames aren't missed). */
function subscribed(): Promise<void> {
  events ??= new Promise((ready) => {
    const source = new EventSource("/__terminal/events");
    source.onopen = () => ready();
    source.onmessage = (m) => {
      const e = JSON.parse(String(m.data)) as TerminalEvent;
      for (const f of terminalListeners) f(e);
    };
  });
  return events;
}
export const onTerminal = (l: (e: TerminalEvent) => void) => {
  void subscribed();
  terminalListeners.add(l);
  return () => {
    terminalListeners.delete(l);
  };
};
export const onSession = (l: (s: Session) => void) => {
  sessionListeners.add(l);
  return () => {
    sessionListeners.delete(l);
  };
};
export const onRunner = none;
export const onInbox = none;
export const onPlanningChanged = none;
export const onNavigate = none;
export const onUpdate = none;
export const onTouchId = (l: (summary: string | null) => void) => {
  if (KEY_FIXTURE === "touch-id") setTimeout(() => l(TOUCH_ID_SUMMARY), 300);
  return () => undefined;
};

// In the real window macOS draws the lights itself.
const lights = document.createElement("div");
lights.setAttribute("aria-hidden", "true");
lights.style.cssText = "position:fixed;top:16px;left:14px;display:flex;gap:8px;z-index:99";
for (const c of ["#ff5f57", "#febc2e", "#28c840"]) {
  const d = document.createElement("span");
  d.style.cssText = `width:12px;height:12px;border-radius:999px;background:${c};box-shadow:inset 0 0 0 .5px rgba(0,0,0,.12)`;
  lights.appendChild(d);
}
if (!inWindow) document.body.appendChild(lights);

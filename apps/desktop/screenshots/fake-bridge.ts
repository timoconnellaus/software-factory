// The screenshot harness's stand-in for src/mainview/bridge.ts (ADR 0460): the same exports, but
// operations are answered from fixtures.ts instead of the main process. vite.config.ts swaps it in.
// It also draws the traffic lights macOS would draw over the toolbar, so shots match the window.
import type { OpName } from "@software-factory/client/ops";
import type { AppRPC, CallResult, RunnerState, Session, UpdateStatus } from "../src/shared/rpc.ts";
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
  engineUrl: "https://sf-engine.example",
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
// A decision waiting for Touch ID, worded as the engine writes it (describeDecision).
const TOUCH_ID_SUMMARY = 'Approve "Add rate limiting to the public API" in API Platform';
const runner: RunnerState = { status: "running", pid: 4242, restarts: 0, lastLine: null };

/**
 * Updates (ADR 0393): a page loaded with `?update=ready|jobs|download` (before the hash) shows the
 * Update required screen in that state; anything else is a current build.
 */
function updateStatus(): UpdateStatus {
  const which = new URLSearchParams(location.search).get("update");
  // Restart to update under way (`?applying=verifying|waiting|restarting|refused`).
  const step = new URLSearchParams(location.search).get("applying");
  const applying = step
    ? {
        step: step as "verifying" | "waiting" | "restarting" | "refused",
        version: "0.1.42",
        reason:
          step === "refused" ? "Version 0.1.42 was refused: its signature didn't check out." : null,
      }
    : null;
  return {
    applying,
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
    if (e instanceof Refusal)
      return { ok: false, code: e.code, error: e.message, details: e.details } as CallResult;
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

/** `?session=slow`: the main process never answers, so the window shows its loading shell. */
const SLOW = SESSION_FIXTURE === "slow";
export const bun = {
  session: async () => {
    if (SLOW) await new Promise(() => undefined);
    return { ...session };
  },
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
  titleBarDoubleClick: async () => {
    const call = await mainProcess();
    return call
      ? ((await call("titleBarDoubleClick")) as { action: "zoom" | "minimize" | "none" })
      : { action: "none" as const };
  },
};

const none = () => () => undefined;

export const onTerminal = none;
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

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
import { ANSWERS } from "./fixtures.ts";

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
  keyStorage: "secure-enclave",
  signingIn: false,
  error: null,
};
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
  };
}

function answer(op: string, input: unknown): CallResult {
  const f = ANSWERS[op as OpName] as ((i: unknown) => unknown) | undefined;
  if (!f) return { ok: false, code: "unavailable", error: `no fixture for ${op}` };
  return { ok: true, result: f(input) };
}

export const bun = {
  session: async () => session,
  signIn: async () => session,
  signOut: async () => session,
  call: async (p: { op: string; input: unknown }) => answer(p.op, p.input),
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
    await subscribed();
    return post<{ ok: boolean; error: string | null }>("open", { ...p, mode: TERMINAL_MODE });
  },
  terminalSend: (p: { id: string; data: string }) => post<{ ok: boolean }>("send", p),
  terminalClose: (p: { id: string }) => post<{ ok: boolean }>("close", p),
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
export const onSession = none;
export const onRunner = none;
export const onInbox = none;
export const onPlanningChanged = none;
export const onNavigate = none;
export const onUpdate = none;

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

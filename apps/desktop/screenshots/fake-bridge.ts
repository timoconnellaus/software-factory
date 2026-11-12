// The screenshot harness's stand-in for src/mainview/bridge.ts (ADR 0460): the same exports, but
// operations are answered from fixtures.ts instead of the main process. vite.config.ts swaps it in.
// It also draws the traffic lights macOS would draw over the toolbar, so shots match the window.
import type { OpName } from "@software-factory/client/ops";
import type { CallResult, RunnerState, Session } from "../src/shared/rpc.ts";
import { ANSWERS } from "./fixtures.ts";

const session: Session = {
  signedIn: true,
  login: "owner",
  deviceId: "dev_m5",
  keyStorage: "secure-enclave",
  signingIn: false,
  error: null,
};
const runner: RunnerState = { status: "running", pid: 4242, restarts: 0, lastLine: null };

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
};

const none = () => () => undefined;
export const onSession = none;
export const onRunner = none;
export const onInbox = none;
export const onPlanningChanged = none;
export const onNavigate = none;

const lights = document.createElement("div");
lights.setAttribute("aria-hidden", "true");
lights.style.cssText = "position:fixed;top:16px;left:14px;display:flex;gap:8px;z-index:99";
for (const c of ["#ff5f57", "#febc2e", "#28c840"]) {
  const d = document.createElement("span");
  d.style.cssText = `width:12px;height:12px;border-radius:999px;background:${c};box-shadow:inset 0 0 0 .5px rgba(0,0,0,.12)`;
  lights.appendChild(d);
}
document.body.appendChild(lights);

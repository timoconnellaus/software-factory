// The view's end of the RPC (ADR 0390). Everything privileged is in the main process.
import Electrobun, { Electroview } from "electrobun/view";
import type { AppRPC, RunnerState, Session, TerminalEvent, UpdateStatus } from "../shared/rpc.ts";
import { bunRequests } from "./request.ts";

type Listener<T> = (v: T) => void;
const listeners = {
  session: new Set<Listener<Session>>(),
  runner: new Set<Listener<RunnerState>>(),
  inbox: new Set<Listener<number>>(),
  planning: new Set<Listener<string>>(),
  navigate: new Set<Listener<string>>(),
  update: new Set<Listener<UpdateStatus>>(),
  terminal: new Set<Listener<TerminalEvent>>(),
  touchId: new Set<Listener<string | null>>(),
};

const rpc = Electroview.defineRPC<AppRPC>({
  maxRequestTime: 120_000,
  handlers: {
    requests: {},
    messages: {
      sessionChanged: (s) => {
        for (const l of listeners.session) l(s);
      },
      runnerChanged: (s) => {
        for (const l of listeners.runner) l(s);
      },
      inboxChanged: ({ count }) => {
        for (const l of listeners.inbox) l(count);
      },
      planningChanged: ({ workItemId }) => {
        for (const l of listeners.planning) l(workItemId);
      },
      navigate: ({ path }) => {
        for (const l of listeners.navigate) l(path);
      },
      updateChanged: (u) => {
        for (const l of listeners.update) l(u);
      },
      terminalEvent: (e) => {
        for (const l of listeners.terminal) l(e);
      },
      touchIdChanged: ({ summary }) => {
        for (const l of listeners.touchId) l(summary);
      },
    },
  },
});
const view = new Electrobun.Electroview({ rpc });

// Not `view.rpc.request.<name>`: see request.ts (`request.call` would be Function.prototype.call).
export const bun = bunRequests((method, params) =>
  // biome-ignore lint/suspicious/noExplicitAny: Electroview's request function is loosely typed.
  (view.rpc as any).request(method, params),
);

function on<K extends keyof typeof listeners>(
  kind: K,
  l: (typeof listeners)[K] extends Set<infer L> ? L : never,
) {
  const set = listeners[kind] as Set<typeof l>;
  set.add(l);
  return () => {
    set.delete(l);
  };
}
export const onSession = (l: Listener<Session>) => on("session", l);
export const onRunner = (l: Listener<RunnerState>) => on("runner", l);
export const onInbox = (l: Listener<number>) => on("inbox", l);
/** A Planning view this person has open changed on the engine (spec 26). */
export const onPlanningChanged = (l: Listener<string>) => on("planning", l);
export const onNavigate = (l: Listener<string>) => on("navigate", l);
export const onUpdate = (l: Listener<UpdateStatus>) => on("update", l);
export const onTerminal = (l: Listener<TerminalEvent>) => on("terminal", l);
/** A decision waiting for Touch ID (its summary), or none (spec 40 M4b). */
export const onTouchId = (l: Listener<string | null>) => on("touchId", l);

// The view's end of the RPC (ADR 0390). Everything privileged is in the main process.
import Electrobun, { Electroview } from "electrobun/view";
import type { AppRPC, RunnerState, Session, UpdateStatus } from "../shared/rpc.ts";
import { bunRequests } from "./request.ts";

type Listener<T> = (v: T) => void;
const listeners = {
  session: new Set<Listener<Session>>(),
  runner: new Set<Listener<RunnerState>>(),
  inbox: new Set<Listener<number>>(),
  navigate: new Set<Listener<string>>(),
  update: new Set<Listener<UpdateStatus>>(),
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
      navigate: ({ path }) => {
        for (const l of listeners.navigate) l(path);
      },
      updateChanged: (u) => {
        for (const l of listeners.update) l(u);
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
export const onNavigate = (l: Listener<string>) => on("navigate", l);
export const onUpdate = (l: Listener<UpdateStatus>) => on("update", l);

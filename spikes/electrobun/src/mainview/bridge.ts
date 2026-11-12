// The view's end of the RPC. Everything privileged (the token, the runner, the dock) is in Bun.
import Electrobun, { Electroview } from "electrobun/view";
import type { AppRPC, RunnerState } from "../shared/rpc.ts";

type Listener<T> = (v: T) => void;
const runnerListeners = new Set<Listener<RunnerState>>();
const linkListeners = new Set<Listener<string>>();

const rpc = Electroview.defineRPC<AppRPC>({
	maxRequestTime: 10_000,
	handlers: {
		requests: {},
		messages: {
			runnerChanged: (s) => {
				for (const l of runnerListeners) l(s);
			},
			deepLink: ({ url }) => {
				for (const l of linkListeners) l(url);
			},
		},
	},
});
const view = new Electrobun.Electroview({ rpc });

// biome-ignore lint/suspicious/noExplicitAny: the generated request proxy is typed loosely.
export const bun = view.rpc!.request as any as {
	[K in keyof AppRPC["bun"]["requests"]]: (p: AppRPC["bun"]["requests"][K]["params"]) => Promise<AppRPC["bun"]["requests"][K]["response"]>;
};
export const onRunner = (l: Listener<RunnerState>) => {
	runnerListeners.add(l);
	return () => void runnerListeners.delete(l);
};
export const onDeepLink = (l: Listener<string>) => {
	linkListeners.add(l);
	return () => void linkListeners.delete(l);
};

// The RPC between the Bun main process and the webview. The view never holds the desktop token:
// it asks Bun to make calls, and Bun reads the token from the Keychain.
export type RunnerState = {
	status: "stopped" | "starting" | "running" | "restarting" | "failed";
	pid: number | null;
	restarts: number;
	lastLine: string | null;
	which: "fake" | "sf-runner";
};

export type AppRPC = {
	bun: {
		requests: {
			runnerState: { params: Record<string, never>; response: RunnerState };
			runnerCrash: { params: Record<string, never>; response: { ok: boolean } };
			runnerUse: { params: { which: "fake" | "sf-runner" }; response: RunnerState };
			tokenSave: { params: { token: string }; response: { ok: boolean; status: number } };
			tokenRead: { params: Record<string, never>; response: { present: boolean; preview: string | null; status: number } };
			setBadge: { params: { count: number }; response: { ok: boolean } };
			notify: { params: { title: string; body: string }; response: { ok: boolean } };
			lastDeepLink: { params: Record<string, never>; response: { url: string | null } };
			takeDeepLink: { params: Record<string, never>; response: { url: string | null } };
			/** The view reports it rendered (self-test). */
			viewReady: { params: { route: string; text: string; runner: RunnerState }; response: { ok: boolean } };
		};
		messages: Record<string, never>;
	};
	webview: {
		requests: Record<string, never>;
		messages: {
			runnerChanged: RunnerState;
			deepLink: { url: string };
		};
	};
};

// A TanStack Router SPA (hash history: views:// has no server for paths) on packages/ui.
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	createHashHistory,
	createRootRoute,
	createRoute,
	createRouter,
	Link,
	Outlet,
	RouterProvider,
	useNavigate,
} from "@tanstack/react-router";
import { Button } from "@software-factory/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@software-factory/ui/components/card";
import { Input } from "@software-factory/ui/components/input";
import { StatusDot } from "@software-factory/ui/components/status-dot";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { RunnerState } from "../shared/rpc.ts";
import { bun, onDeepLink, onRunner } from "./bridge.ts";
import "./styles.css";

const qc = new QueryClient();

// Self-test plumbing: surface view errors in Bun's log.
const fail = (text: string) => void bun.viewReady({ route: "error", text, runner: { status: "failed", pid: null, restarts: 0, lastLine: null, which: "fake" } });
window.addEventListener("error", (e) => fail(`error: ${e.message}`));
window.addEventListener("unhandledrejection", (e) => fail(`rejection: ${String(e.reason)}`));

function Shell() {
	const navigate = useNavigate();
	useEffect(() => {
		const go = (url: string) => {
			const u = new URL(url);
			const path = `/${u.host}${u.pathname}`.replace(/\/$/, "");
			if (path.startsWith("/work/")) navigate({ to: "/work/$id", params: { id: path.slice(6) } });
			else navigate({ to: "/settings" });
		};
		// A link that launched the app arrives before the view listens: Bun holds it, we pull it.
		void bun.takeDeepLink({}).then(({ url }) => url && go(url));
		return onDeepLink(go);
	}, [navigate]);
	return (
		<div className="flex min-h-screen bg-background text-foreground">
			<nav className="flex w-48 flex-col gap-1 border-r bg-sidebar p-3 text-sm">
				<Link to="/" className="rounded px-2 py-1 [&.active]:bg-sidebar-accent">Runner</Link>
				<Link to="/settings" className="rounded px-2 py-1 [&.active]:bg-sidebar-accent">Token &amp; native</Link>
				<Link to="/work/$id" params={{ id: "1" }} className="rounded px-2 py-1 [&.active]:bg-sidebar-accent">Work item 1</Link>
			</nav>
			<main className="flex-1 p-6"><Outlet /></main>
		</div>
	);
}

const dot = (s: RunnerState["status"]) => (s === "running" ? "running" : s === "failed" ? "failed" : s === "stopped" ? "idle" : "waiting");

function RunnerPage() {
	const client = useQueryClient();
	const { data } = useQuery({ queryKey: ["runner"], queryFn: () => bun.runnerState({}) });
	useEffect(() => onRunner((s) => client.setQueryData(["runner"], s)), [client]);
	const loaded = !!data;
	useEffect(() => {
		if (!loaded) return;
		// After paint: tell Bun what rendered, through the same RPC (self-test evidence).
		requestAnimationFrame(() => {
			const runner = client.getQueryData<RunnerState>(["runner"]);
			if (runner) void bun.viewReady({ route: location.hash, text: document.body.innerText.slice(0, 200), runner });
		});
	}, [loaded, client]);
	if (!data) return null;
	return (
		<Card className="max-w-xl">
			<CardHeader><CardTitle className="flex items-center gap-2"><StatusDot status={dot(data.status)} /> Runner: {data.status}</CardTitle></CardHeader>
			<CardContent className="space-y-3 text-sm">
				<div>child: {data.which} · pid {data.pid ?? "—"} · restarts {data.restarts}</div>
				<pre className="overflow-x-auto rounded bg-muted p-2 font-mono text-xs">{data.lastLine ?? "…"}</pre>
				<div className="flex gap-2">
					<Button size="sm" variant="outline" onClick={() => bun.runnerCrash({})}>Crash it</Button>
					<Button size="sm" variant="outline" onClick={() => bun.runnerUse({ which: "sf-runner" })}>Run real sf-runner status</Button>
					<Button size="sm" variant="outline" onClick={() => bun.runnerUse({ which: "fake" })}>Back to fake runner</Button>
				</div>
			</CardContent>
		</Card>
	);
}

function SettingsPage() {
	const [token, setToken] = useState("sfd_spike_" + Math.random().toString(36).slice(2));
	const [out, setOut] = useState<string>("");
	const { data: link } = useQuery({ queryKey: ["link"], queryFn: () => bun.lastDeepLink({}), refetchInterval: 1000 });
	return (
		<div className="max-w-xl space-y-4">
			<Card>
				<CardHeader><CardTitle>Desktop token (Keychain)</CardTitle></CardHeader>
				<CardContent className="space-y-2 text-sm">
					<Input value={token} onChange={(e) => setToken(e.target.value)} />
					<div className="flex gap-2">
						<Button size="sm" onClick={async () => setOut(JSON.stringify(await bun.tokenSave({ token })))}>Save</Button>
						<Button size="sm" variant="outline" onClick={async () => setOut(JSON.stringify(await bun.tokenRead({})))}>Read</Button>
					</div>
					<pre className="rounded bg-muted p-2 font-mono text-xs">{out}</pre>
				</CardContent>
			</Card>
			<Card>
				<CardHeader><CardTitle>Native</CardTitle></CardHeader>
				<CardContent className="flex flex-wrap gap-2 text-sm">
					<Button size="sm" variant="outline" onClick={() => bun.setBadge({ count: 3 })}>Badge 3</Button>
					<Button size="sm" variant="outline" onClick={() => bun.setBadge({ count: 0 })}>Clear badge</Button>
					<Button size="sm" variant="outline" onClick={() => bun.notify({ title: "Spec waiting", body: "Work item 1 needs your approval" })}>Notify</Button>
					<div className="w-full text-muted-foreground">last deep link: {link?.url ?? "none"}</div>
				</CardContent>
			</Card>
		</div>
	);
}

function WorkPage() {
	const { id } = workRoute.useParams();
	return <Card className="max-w-xl"><CardHeader><CardTitle>Work item {id}</CardTitle></CardHeader><CardContent className="text-sm text-muted-foreground">Reached by route or by sf-spike://work/{id}.</CardContent></Card>;
}

const root = createRootRoute({ component: Shell });
const workRoute = createRoute({ getParentRoute: () => root, path: "/work/$id", component: WorkPage });
const router = createRouter({
	history: createHashHistory(),
	routeTree: root.addChildren([
		createRoute({ getParentRoute: () => root, path: "/", component: RunnerPage }),
		createRoute({ getParentRoute: () => root, path: "/settings", component: SettingsPage }),
		workRoute,
	]),
});
declare module "@tanstack/react-router" {
	interface Register {
		router: typeof router;
	}
}

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<QueryClientProvider client={qc}><RouterProvider router={router} /></QueryClientProvider>
	</StrictMode>,
);

// The spike's main process (Bun): a menu-bar app that owns a window, a supervised runner child,
// the desktop token in the Keychain, the sf-spike:// deep link, notifications and the dock badge.
import Electrobun, { BrowserView, BrowserWindow, Tray, Utils } from "electrobun/main";
import type { AppRPC, RunnerState } from "../shared/rpc.ts";
import { setDockBadge } from "./dock.ts";
import { readToken, saveToken } from "./keychain.ts";
import { report, selftest } from "./selftest.ts";
import { Supervisor } from "./supervisor.ts";

let lastDeepLink: string | null = null;
let pendingDeepLink: string | null = null;
let win: BrowserWindow | null = null;
let badge = 0;
const debug = process.env.SF_SPIKE_SELFTEST
	? Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async (req) => (report("view.debug", await req.json()), new Response("ok", { headers: { "access-control-allow-origin": "*" } })) })
	: null;
const debugPort = debug?.port ?? 0;

const rpc = BrowserView.defineRPC<AppRPC>({
	maxRequestTime: 10_000,
	handlers: {
		requests: {
			runnerState: () => supervisor.state,
			runnerCrash: () => ({ ok: supervisor.crash() }),
			runnerUse: async ({ which }) => {
				await supervisor.use(which);
				return supervisor.state;
			},
			tokenSave: ({ token }) => {
				const status = saveToken(token);
				return { ok: status === 0, status };
			},
			tokenRead: () => {
				const { status, token } = readToken();
				return { present: token !== null, preview: token ? `${token.slice(0, 6)}…` : null, status };
			},
			setBadge: ({ count }) => {
				badge = count;
				setDockBadge(count);
				refreshTray();
				return { ok: true };
			},
			notify: ({ title, body }) => {
				Utils.showNotification({ title, body });
				return { ok: true };
			},
			lastDeepLink: () => ({ url: lastDeepLink }),
			takeDeepLink: () => {
				const url = pendingDeepLink;
				pendingDeepLink = null;
				return { url };
			},
			viewReady: (r) => {
				report("view", { rendered: true, route: r.route, text: r.text.replace(/\s+/g, " "), runnerSeenByView: r.runner.status });
				return { ok: true };
			},
		},
		messages: {},
	},
});

function openWindow() {
	if (win) {
		win.focus();
		return;
	}
	win = new BrowserWindow({
		title: "Software Factory (spike)",
		url: "views://mainview/index.html",
		rpc,
		frame: { width: 1100, height: 760, x: 120, y: 80 },
	});
	win.webview.on("dom-ready", () => {
		console.log("[view] dom-ready");
		if (!process.env.SF_SPIKE_SELFTEST) return;
		// Debug channel for the self-test: the page posts what it sees to a loopback port.
		const js = `setTimeout(() => fetch("http://127.0.0.1:${debugPort}/", { method: "POST", body: JSON.stringify({
			hash: location.hash, rootChildren: document.getElementById("root")?.childElementCount ?? -1,
			text: document.body.innerText.slice(0, 300), scripts: [...document.scripts].map((s) => s.src),
			electrobun: typeof window.__electrobun, keys: Object.keys(window).filter((k) => k.toLowerCase().includes("electrobun")),
		}) }).catch(() => {}), 2500);
		setTimeout(() => fetch("http://127.0.0.1:${debugPort}/", { method: "POST", body: JSON.stringify({ later: true, text: document.body.innerText.slice(0, 300) }) }).catch(() => {}), 7000);`;
		win?.webview.executeJavascript(js);
	});
	win.webview.on("did-navigate", (e: unknown) => console.log(`[view] did-navigate ${JSON.stringify((e as { data?: unknown }).data)}`));
	win.on("close", () => {
		win = null;
	});
}

const send = () => win?.webview.rpc as unknown as { send: AppRPC["webview"]["messages"] extends infer M ? { [K in keyof M]: (p: M[K]) => void } : never } | undefined;

const supervisor = new Supervisor((s: RunnerState) => {
	send()?.send.runnerChanged(s);
	refreshTray();
});

const tray = new Tray({ title: "SF" });
function refreshTray() {
	const s = supervisor.state;
	tray.setTitle(`SF ${s.status === "running" ? "●" : "○"}${badge ? ` ${badge}` : ""}`);
	tray.setMenu([
		{ type: "normal", label: `Runner: ${s.status}${s.pid ? ` (pid ${s.pid})` : ""}`, action: "noop", enabled: false },
		{ type: "normal", label: `Inbox: ${badge}`, action: "open" },
		{ type: "divider" },
		{ type: "normal", label: "Open Software Factory", action: "open" },
		{ type: "normal", label: "Quit", action: "quit" },
	]);
}
tray.on("tray-clicked", async (e: unknown) => {
	const action = (e as { data?: { action?: string } }).data?.action;
	if (action === "open") openWindow();
	if (action === "quit") {
		await supervisor.stop();
		Utils.quit();
	}
});

// Deep links: sf-spike://auth/callback?code=… (sign-in) and sf-spike://work/123.
Electrobun.events.on("open-url", (e: { data: { url: string } }) => {
	lastDeepLink = e.data.url;
	pendingDeepLink = e.data.url;
	console.log(`open-url ${e.data.url}`);
	if (process.env.SF_SPIKE_SELFTEST) {
		report("open-url", { url: e.data.url, windowOpen: !!win });
		setTimeout(() => win?.webview.executeJavascript(`fetch("http://127.0.0.1:${debugPort}/", { method: "POST", body: JSON.stringify({ afterLink: true, hash: location.hash, text: document.querySelector("main")?.innerText.slice(0, 120) }) })`), 800);
	}
	openWindow();
	send()?.send.deepLink({ url: e.data.url });
});

// Quitting stops the runner cleanly first.
Electrobun.events.on("before-quit", async () => {
	await supervisor.stop();
});

refreshTray();
supervisor.start("fake");
openWindow();
if (process.env.SF_SPIKE_SELFTEST) void selftest(supervisor, () => lastDeepLink, () => win?.close());
console.log(`main pid=${process.pid} execPath=${process.execPath} cwd=${process.cwd()}`);

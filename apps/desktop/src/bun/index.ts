// The desktop app's main process (Bun; ADR 0390, spec 40 M2): the window, the menu-bar icon, the
// RPC the view calls, the sf:// links, the inbox count (badge, notifications) and this Mac's runner.
// The desktop token and the device key stay here; the view only ever sees results.
import { hostname } from "node:os";
import { join } from "node:path";
import Electrobun, { BrowserView, BrowserWindow, Tray, Utils } from "electrobun/main";
import type { AppRPC, RunnerState } from "../shared/rpc.ts";
import { Auth } from "./auth.ts";
import { parseDeepLink } from "./deeplink.ts";
import { Door } from "./door.ts";
import { acquireInstanceLock, watchParent } from "./instance.ts";
import { Live, liveUrl } from "./live.ts";
import { loginItemEnabled, setDockBadge, setLoginItem } from "./macos.ts";
import { operationHandlers } from "./operations.ts";
import { Runner } from "./runner.ts";
import { saveTo } from "./save.ts";

const ENGINE_URL = process.env.SF_ENGINE_URL ?? "https://sf-engine.zerobsai.com";
/** The inbox count's fallback refresh; the live socket brings changes the moment they happen. */
const INBOX_POLL_MS = 60_000;

const dataDir = join(Utils.paths.appData, "com.software-factory.desktop");
if (!acquireInstanceLock(dataDir)) {
  console.log("Software Factory is already running");
  process.exit(0);
}

async function deviceName(): Promise<string> {
  try {
    const p = Bun.spawn(["/usr/sbin/scutil", "--get", "ComputerName"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const name = (await new Response(p.stdout).text()).trim();
    if (name) return name.replace(/[^\w .@:'’()-]/g, "").slice(0, 80) || "Mac";
  } catch {
    // fall through
  }
  return (
    hostname()
      .replace(/\.local$/, "")
      .replace(/[^\w .@:'’()-]/g, "")
      .slice(0, 80) || "Mac"
  );
}

let auth: Auth;
const door = () => new Door(ENGINE_URL, () => auth.currentToken());
auth = new Auth(door, await deviceName());
await auth.init();

let win: BrowserWindow | null = null;
let pendingPath: string | null = null;
let inboxCount = 0;
let seenGates = new Set<string>();

type ViewMessages = AppRPC["webview"]["messages"];
const toView = <K extends keyof ViewMessages>(name: K, payload: ViewMessages[K]) => {
  const rpc = win?.webview.rpc as unknown as
    | { send: { [P in keyof ViewMessages]: (p: ViewMessages[P]) => void } }
    | undefined;
  rpc?.send[name](payload);
};

const ops = operationHandlers({
  door,
  signer: () => {
    const key = auth.key;
    return key ? (m: string) => key.sign(m) : null;
  },
  signedOut: () => {
    auth.forget();
    toView("sessionChanged", auth.session());
    refreshTray();
  },
});
const guarded = ops.guarded;

const rpc = BrowserView.defineRPC<AppRPC>({
  maxRequestTime: 120_000,
  handlers: {
    requests: {
      session: () => auth.session(),
      signIn: async () => {
        try {
          Utils.openExternal(await auth.start());
        } catch (error) {
          auth.error = error instanceof Error ? error.message : "couldn't start the sign-in";
        }
        return auth.session();
      },
      signOut: async () => {
        live.stop();
        await auth.signOut();
        setBadge(0);
        return auth.session();
      },
      // Operations through the client door; gate decisions only through decide (operations.ts).
      call: ops.call,
      batch: ops.batch,
      decide: ops.decide,
      runnerState: () => runner.state,
      runnerAction: async ({ action }) => {
        if (action === "takeover") await runner.takeOverFromLaunchd();
        if (action === "restart") await runner.restart();
        if (action === "pair") void runner.pair((url) => Utils.openExternal(url));
        return runner.state;
      },
      loginItem: ({ enable }) => ({
        enabled: enable === undefined ? loginItemEnabled() : setLoginItem(enable),
      }),
      openExternal: ({ url }) => ({ ok: /^https:\/\//.test(url) && Utils.openExternal(url) }),
      saveDownload: ({ filename, base64 }) => {
        try {
          const path = saveTo(Utils.paths.downloads, filename, Buffer.from(base64, "base64"));
          Utils.showItemInFolder(path);
          return { ok: true, path };
        } catch {
          return { ok: false, path: null };
        }
      },
    },
    messages: {},
  },
});

function openWindow(path?: string) {
  if (path) pendingPath = path;
  if (win) {
    win.focus();
    if (path) toView("navigate", { path });
    return;
  }
  win = new BrowserWindow({
    title: "Software Factory",
    url: "views://mainview/index.html",
    rpc,
    frame: { width: 1200, height: 800, x: 120, y: 80 },
    // The view draws the toolbar under the traffic lights and marks it as the drag region (spec 41).
    titleBarStyle: "hiddenInset",
    trafficLightOffset: { x: 14, y: 16 },
  });
  // A link that launched the app arrives before the view listens: send it once the page is up.
  win.webview.on("dom-ready", () => {
    if (pendingPath) toView("navigate", { path: pendingPath });
    pendingPath = null;
  });
  win.on("close", () => {
    win = null;
  });
}

const runner = new Runner((s: RunnerState) => {
  toView("runnerChanged", s);
  refreshTray();
});

const tray = new Tray({ title: "SF" });
const RUNNER_LABEL: Record<RunnerState["status"], string> = {
  unpaired: "not paired",
  launchd: "run by launchd",
  stopped: "stopped",
  starting: "starting",
  running: "running",
  restarting: "restarting",
  locked: "another host is running",
  failed: "failed",
};
function refreshTray() {
  const s = runner.state;
  tray.setTitle(`SF${inboxCount ? ` ${inboxCount}` : ""}${s.status === "running" ? " ●" : ""}`);
  tray.setMenu([
    {
      type: "normal",
      label: auth.session().signedIn ? `Waiting on you: ${inboxCount}` : "Not signed in",
      action: "open",
    },
    { type: "normal", label: `Runner: ${RUNNER_LABEL[s.status]}`, action: "noop", enabled: false },
    ...(s.status === "unpaired"
      ? [{ type: "normal" as const, label: "Pair this Mac as a runner…", action: "pair" }]
      : []),
    ...(s.status === "launchd"
      ? [
          {
            type: "normal" as const,
            label: "Run the runner in this app instead of launchd",
            action: "takeover",
          },
        ]
      : []),
    { type: "divider" },
    { type: "normal", label: "Open Software Factory", action: "open" },
    { type: "normal", label: "Launch at login", action: "login-item", checked: loginItemEnabled() },
    { type: "normal", label: "Quit", action: "quit" },
  ]);
}
tray.on("tray-clicked", async (e: unknown) => {
  const action = (e as { data?: { action?: string } }).data?.action;
  if (action === "open") openWindow();
  if (action === "pair") void runner.pair((url) => Utils.openExternal(url));
  if (action === "takeover") await runner.takeOverFromLaunchd();
  if (action === "login-item") {
    setLoginItem(!loginItemEnabled());
    refreshTray();
  }
  if (action === "quit") await quit();
});

function setBadge(count: number) {
  inboxCount = count;
  setDockBadge(count);
  toView("inboxChanged", { count });
  refreshTray();
}

/** The inbox count, and a notification for each gate or question that wasn't there before. */
async function pollInbox(opts: { notify?: boolean } = {}) {
  if (!auth.session().signedIn) return;
  const res = await guarded(() => door().call("inbox.list", {}), {
    ok: false,
    code: "unauthenticated",
    error: "",
  });
  if (!res.ok) return;
  const inbox = res.result as {
    gates: { id: string; kind: string; title: string; workItemId: string | null }[];
    questions: { id: string; title: string; prompt: string; workItemId: string }[];
  };
  const waiting = [
    ...inbox.gates.map((g) => ({ id: g.id, title: `${gateLabel(g.kind)}: ${g.title}` })),
    ...inbox.questions.map((q) => ({ id: q.id, title: `Question: ${q.title}` })),
  ];
  const fresh = waiting.filter((w) => !seenGates.has(w.id));
  // Not on the first poll after launch: those were waiting already.
  if (opts.notify !== false && (seenGates.size > 0 || inboxCount > 0)) {
    for (const w of fresh.slice(0, 3))
      Utils.showNotification({ title: "Software Factory", body: w.title });
  }
  seenGates = new Set(waiting.map((w) => w.id));
  setBadge(waiting.length);
}
const gateLabel = (kind: string) =>
  kind === "spec" ? "Spec waiting" : kind === "merge" ? "Ready to merge" : "Approval needed";

// The live socket (spec 40 M2b): a gate opening reaches the badge and a notification at once.
const live = new Live(liveUrl(ENGINE_URL), () => auth.currentToken(), {
  connected: () => void pollInbox(),
  event: (e) => {
    // A Planning view this person has open changed (spec 26): the view re-reads it.
    if (e.type === "planning.changed" && e.workItemId) {
      toView("planningChanged", { workItemId: e.workItemId });
      return;
    }
    if (e.type !== "notify") return;
    void pollInbox({ notify: false }).then(() => {
      if (e.title) Utils.showNotification({ title: "Software Factory", body: e.title });
    });
  },
});

Electrobun.events.on("open-url", async (e: { data: { url: string } }) => {
  const link = parseDeepLink(e.data.url);
  if (link.kind === "auth") {
    await auth.finish(link.code, link.state);
    toView("sessionChanged", auth.session());
    live.start();
    void pollInbox();
    openWindow();
  } else if (link.kind === "route") {
    openWindow(link.path);
  } else {
    openWindow();
  }
});

async function quit() {
  live.stop();
  await runner.stop();
  Utils.quit();
}
Electrobun.events.on("before-quit", async () => {
  await runner.stop();
});
// If the launcher dies, don't linger as an orphan with a runner (ADR 0390).
watchParent(() => void quit());

refreshTray();
void runner.start();
live.start();
void pollInbox();
setInterval(() => void pollInbox(), INBOX_POLL_MS);
openWindow();

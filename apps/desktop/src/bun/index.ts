// The desktop app's main process (Bun; ADR 0390, spec 40 M2): the window, the menu-bar icon, the
// RPC the view calls, the sf:// links, the inbox count (badge, notifications) and this Mac's runner.
// The desktop token and the device key stay here; the view only ever sees results.
import { hostname } from "node:os";
import { join } from "node:path";
import Electrobun, {
  ApplicationMenu,
  BrowserView,
  BrowserWindow,
  Tray,
  Updater,
  Utils,
} from "electrobun/main";
import type { AppRPC, RunnerState, UpdateStatus } from "../shared/rpc.ts";
import { checkSummary } from "../shared/update-check.ts";
import { Auth } from "./auth.ts";
import { parseDeepLink } from "./deeplink.ts";
import { Door } from "./door.ts";
import { acquireInstanceLock, watchParent } from "./instance.ts";
import { Live, liveUrl } from "./live.ts";
import { loginItemEnabled, setDockBadge, setLoginItem } from "./macos.ts";
import { operationHandlers } from "./operations.ts";
import { DRAIN_TIMEOUT_MS, restartToUpdate as restartUpdate } from "./restart-update.ts";
import { Runner } from "./runner.ts";
import { liveJobs } from "./runner-jobs.ts";
import { saveTo } from "./save.ts";
import { Terminals } from "./terminal.ts";
import { titleBarDoubleClick } from "./title-bar.ts";
import { bunExec, runningAppPath } from "./update-verify.ts";
import { type UpdaterLike, Updates } from "./updates.ts";
import { viewUrl } from "./view-url.ts";

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
// A door that says this build is too old (ADR 0393) sends the updater to look now.
const door = () => new Door(ENGINE_URL, () => auth.currentToken(), fetch, doorSaysUpdate);
auth = new Auth(door, await deviceName());
await auth.init();

const VIEW_URL = viewUrl(await Updater.localInfo.channel(), process.env.SF_VIEW_URL);
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
    terminals.closeAll();
    toView("sessionChanged", auth.session());
    refreshTray();
  },
});
const guarded = ops.guarded;
// Runs' web terminals (spec 42): the door's socket here, its frames to the view over the RPC.
const terminals = new Terminals(
  ENGINE_URL,
  () => auth.currentToken(),
  (e) => toView("terminalEvent", e),
  undefined,
  undefined,
  // A terminal's upgrade refused as too old shows "Update required", as the live socket does.
  { updateRequired: () => doorSaysUpdate() },
);

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
        terminals.closeAll();
        await auth.signOut();
        setBadge(0);
        return auth.session();
      },
      // Operations through the client door; gate decisions only through decide (operations.ts).
      call: ops.call,
      batch: ops.batch,
      decide: ops.decide,
      terminalOpen: (p) => terminals.open(p),
      terminalSend: (p) => terminals.send(p),
      terminalClose: (p) => terminals.close(p),
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
      titleBarDoubleClick: async () => ({ action: await titleBarDoubleClick(win) }),
      openExternal: ({ url }) => ({ ok: /^https:\/\//.test(url) && Utils.openExternal(url) }),
      updateStatus: () => updateStatus(),
      updateAction: async ({ action }) => {
        if (action === "restart" && liveJobs().length === 0) await restartToUpdate();
        if (action === "restart-when-idle") restartWhenIdle = true;
        // The view named the jobs this cancels.
        if (action === "restart-anyway") await restartToUpdate(true);
        if (action === "download") Utils.openExternal(downloadUrl);
        if (action === "retry") {
          updateRequired = false;
          live.start();
        }
        // Settings > This Mac: the view shows the check as it runs (updateChanged).
        if (action === "check") void updates.checkByPerson();
        pushUpdate();
        return updateStatus();
      },
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
    url: VIEW_URL,
    rpc,
    frame: { width: 1200, height: 800, x: 120, y: 80 },
    // The view draws the toolbar under the traffic lights and marks it as the drag region (spec 41).
    titleBarStyle: "hiddenInset",
    trafficLightOffset: { x: 5, y: 6 },
  });
  // A link that launched the app arrives before the view listens: send it once the page is up.
  // A (re)load also means no view holds the open terminals' handles any more (a reload, or WebKit
  // restarting its content process): close them, or each keeps an attach and a relay viewer slot.
  win.webview.on("dom-ready", () => {
    terminals.closeAll();
    if (pendingPath) toView("navigate", { path: pendingPath });
    pendingPath = null;
  });
  win.on("close", () => {
    win = null;
    terminals.closeAll();
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
let told: string | null = null;
let logged: string | null = null;
const updates = new Updates(
  // Electrobun's Updater has more than this; these are the parts updates.ts uses.
  { updater: Updater as unknown as UpdaterLike, exec: bunExec, appPath: runningAppPath() },
  (u) => {
    const say = u.ready && u.version ? `ready:${u.version}` : u.needsMove ? "move" : null;
    if (say && say !== told) {
      Utils.showNotification({
        title: "Software Factory",
        body: u.ready
          ? `Version ${u.version} is ready: restart to update`
          : (u.error ?? "Move the app to Applications to get updates"),
      });
    }
    told = say ?? told;
    if (u.error && u.error !== logged) console.log(`updates: ${u.error}`);
    logged = u.error;
    pushUpdate();
  },
);
/**
 * The door answered update_required (ADR 0393): show the view's "Update required" screen and look
 * for an update now (updates.ts throttles how often). The updater talks only to the download
 * bucket, never the door, so a wrong floor on the engine can't stop the app from updating.
 */
let updateRequired = false;
function doorSaysUpdate() {
  if (!updateRequired) {
    updateRequired = true;
    pushUpdate();
  }
  void updates.checkNow();
}
let downloadUrl = "https://downloads.zerobsai.com/desktop/canary-macos-arm64-Software-Factory.zip";
void Updater.localInfo.channel().then((c) => {
  if (c === "stable" || c === "canary")
    downloadUrl = `https://downloads.zerobsai.com/desktop/${c}-macos-arm64-Software-Factory.zip`;
});
function updateStatus(): UpdateStatus {
  const u = updates.state;
  return {
    required: updateRequired,
    ready: u.ready,
    version: u.version,
    error: u.error,
    needsMove: u.needsMove,
    jobs: liveJobs().length,
    waitingForRunner,
    downloadUrl,
    phase: u.phase,
    checkedAt: u.checkedAt,
    installed: u.installed,
    channel: u.channel,
    reason: u.reason,
  };
}

/**
 * Check for Updates… (the app menu and the menu bar): a person asked, so no gap applies; a press
 * while a check runs joins it. With the window open, Settings > This Mac shows the check as it
 * runs; with it closed, the menu bar's status line does, and a notification says what it found.
 */
async function checkFromMenu() {
  if (win) openWindow("/settings");
  const wasReady = updates.state.ready;
  await updates.checkByPerson();
  // Becoming ready already notified (onChange); anything else, or ready again, is said here.
  if (!win && (!updates.state.ready || wasReady))
    Utils.showNotification({ title: "Software Factory", body: checkSummary(updateStatus()) });
}
function pushUpdate() {
  toView("updateChanged", updateStatus());
  refreshTray();
}
/** "Restart to update" is waiting for the runner to stop claiming, until this time (epoch ms). */
let waitingForRunner: number | null = null;
/** The person chose "Restart to update when the runner is idle". */
let restartWhenIdle = false;

/** The update menu items: no job is cancelled for an update unless the person says so. */
function updateItems() {
  const u = updates.state;
  // A check running: its status line, so a person who asked from the menu sees it.
  if (u.phase === "checking" || u.phase === "downloading")
    return [
      {
        type: "normal" as const,
        label: u.phase === "checking" ? "Checking for updates…" : `Downloading ${u.version}…`,
        action: "noop",
        enabled: false,
      },
    ];
  if (u.needsMove)
    return [
      {
        type: "normal" as const,
        label: "Move to Applications to get updates",
        action: "noop",
        enabled: false,
      },
    ];
  if (!u.ready) return [];
  if (waitingForRunner !== null) {
    const s = Math.max(0, Math.ceil((waitingForRunner - Date.now()) / 1000));
    return [
      {
        type: "normal" as const,
        label: `Update to ${u.version}: waiting for the runner (up to ${s} s)…`,
        action: "noop",
        enabled: false,
      },
    ];
  }
  const jobs = liveJobs().length;
  if (jobs === 0)
    return [
      { type: "normal" as const, label: `Restart to update to ${u.version}`, action: "update" },
    ];
  const n = `${jobs} job${jobs === 1 ? "" : "s"}`;
  return [
    {
      type: "normal" as const,
      label: restartWhenIdle
        ? `Update to ${u.version} once ${n} finish${jobs === 1 ? "es" : ""}`
        : `Update to ${u.version}: the runner is running ${n}`,
      action: "noop",
      enabled: false,
    },
    ...(restartWhenIdle
      ? []
      : [
          {
            type: "normal" as const,
            label: "Restart to update when they finish",
            action: "update-when-idle",
          },
        ]),
    {
      type: "normal" as const,
      label: `Restart anyway (cancels ${n}; their unpushed work is lost)`,
      action: "update-anyway",
    },
  ];
}

let restarting = false;
/**
 * Drain the runner (unless the person chose to cancel its jobs), stop it and the live socket, then
 * restart into the update (restart-update.ts). If a job turned up meanwhile, wait for idle. If the
 * update doesn't happen (nothing staged, a refused signature, a quit handler said no, a throw) both
 * come back.
 */
async function restartToUpdate(anyway = false) {
  if (restarting) return;
  restarting = true;
  const wasWaiting = restartWhenIdle;
  restartWhenIdle = false;
  try {
    const outcome = await restartUpdate(
      {
        drain: (ms) => runner.drain(ms),
        // "Waiting for the runner" in the menu and the view, with when it gives up.
        waiting: (until) => {
          waitingForRunner = until;
          pushUpdate();
        },
        liveJobs: () => liveJobs(),
        // The live socket and every open terminal: an update restarts the app under them.
        stopLive: () => {
          live.stop();
          terminals.closeAll();
        },
        startLive: () => live.start(),
        stopRunner: () => runner.stop(),
        startRunner: () => void runner.start(),
        apply: () => updates.apply(),
      },
      { anyway },
    );
    if (outcome === "timeout") {
      restartWhenIdle = true;
      if (!wasWaiting)
        Utils.showNotification({
          title: "Software Factory",
          body: `The runner didn't answer within ${DRAIN_TIMEOUT_MS / 1000} s. The app updates once it is idle; or choose Restart anyway.`,
        });
    } else if (outcome === "deferred") {
      restartWhenIdle = true;
      if (!wasWaiting)
        Utils.showNotification({
          title: "Software Factory",
          body: "The runner is busy: it takes no new jobs, and the app updates once it is idle.",
        });
    } else {
      Utils.showNotification({
        title: "Software Factory",
        body: `The update didn't install: ${updates.state.error ?? "unknown error"}`,
      });
    }
  } catch (error) {
    Utils.showNotification({
      title: "Software Factory",
      body: `The update didn't install: ${error instanceof Error ? error.message : String(error)}`,
    });
  } finally {
    restarting = false;
    refreshTray();
  }
}
// The job count in the menu and the view, and the deferred restart once the runner is idle.
setInterval(() => {
  if (!updates.state.ready) return;
  if (restartWhenIdle && liveJobs().length === 0) void restartToUpdate();
  else pushUpdate();
}, 15_000);

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
    ...updateItems(),
    { type: "normal", label: "Check for Updates…", action: "check-updates" },
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
  // Offered only while the runner is idle; re-checked here in case a job just started.
  if (action === "update") {
    if (liveJobs().length === 0) await restartToUpdate();
    else refreshTray();
  }
  if (action === "update-when-idle") {
    restartWhenIdle = true;
    refreshTray();
  }
  // The person was told how many jobs this cancels.
  if (action === "update-anyway") await restartToUpdate(true);
  if (action === "check-updates") await checkFromMenu();
});

/**
 * The app menu (macOS): About, then Check for Updates…, always enabled. Setting a menu replaces the
 * whole bar, so the standard Edit and Window menus are here too (copy and paste in the view need
 * the Edit roles).
 */
ApplicationMenu.setApplicationMenu([
  {
    label: "Software Factory",
    submenu: [
      { role: "about" },
      { label: "Check for Updates…", action: "check-updates" },
      { type: "divider" },
      { role: "hide" },
      { role: "hideOthers" },
      { role: "showAll" },
      { type: "divider" },
      { role: "quit" },
    ],
  },
  {
    label: "Edit",
    submenu: [
      { role: "undo" },
      { role: "redo" },
      { type: "divider" },
      { role: "cut" },
      { role: "copy" },
      { role: "paste" },
      { role: "pasteAndMatchStyle" },
      { role: "delete" },
      { role: "selectAll" },
    ],
  },
  {
    label: "Window",
    submenu: [
      { role: "minimize" },
      { role: "zoom" },
      { role: "close" },
      { type: "divider" },
      { role: "bringAllToFront" },
    ],
  },
]);
ApplicationMenu.on("application-menu-clicked", (e: unknown) => {
  const action = (e as { data?: { action?: string } }).data?.action;
  if (action === "check-updates") void checkFromMenu();
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
  connected: () => {
    void pollInbox();
    // Pushes may have been missed while the socket was down: open Planning views re-read (spec 26).
    toView("planningChanged", { workItemId: "*" });
  },
  updateRequired: () => doorSaysUpdate(),
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
  terminals.closeAll();
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
void updates.start();
live.start();
void pollInbox();
setInterval(() => void pollInbox(), INBOX_POLL_MS);
openWindow();

// Screenshots of the desktop view (spec 41, spec 70): serves the view with the fixture door
// (vite.config.ts here), drives Chrome headless over CDP at 1440×900, light and dark, and writes
// docs/screenshots/desktop-shell/<screen>-<theme>.png.
// `--out <dir>` writes under docs/screenshots/<dir> instead; `--size WxH` shoots at that size (the
// app's default window is 1200x800) and, with `--tag <t>`, names the files <screen>-<theme>-<t>.png.
// SF_SHOTS_PORT moves the view's server off 5741.
//
//   node apps/desktop/screenshots/shoot.mjs [--out dir] [--size WxH --tag t] [screen ...]
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createServer } from "vite";
import { connect } from "./cdp.mjs";

const here = import.meta.dirname;
const repo = resolve(here, "../../..");
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const out = resolve(repo, "docs/screenshots", flag("--out") ?? "desktop-shell");
const [W, H] = (flag("--size") ?? "1440x900").split("x").map(Number);
const tag = flag("--tag");

/** Each screen: its route, and what to do before the shot. */
export const SCREENS = [
  // The new core's board and item (spec 70, .kim/mockups/board-and-item-panel.html,
  // item-as-a-full-page.html; flow-fixtures.ts). `--out flow-board` writes them there.
  { name: "flow-board", path: "/flow/org_personal/p/fprj_api" },
  { name: "flow-board-list", path: "/flow/org_personal/p/fprj_api?view=list" },
  { name: "flow-item-panel", path: "/flow/org_personal/p/fprj_api?item=fitm_rate" },
  {
    name: "flow-item-panel-decision",
    path: "/flow/org_personal/p/fprj_api?item=fitm_rate",
    clicks: ['[data-testid="jump-to-decision"]'],
  },
  { name: "flow-item-page", path: "/flow/org_personal/p/fprj_api/i/fitm_rate" },
  { name: "flow-item-decision", path: "/flow/org_personal/p/fprj_api?item=fitm_audit" },
  { name: "flow-item-stopped", path: "/flow/org_personal/p/fprj_api?item=fitm_postgres" },
  { name: "flow-project-empty", path: "/flow/org_personal/p/fprj_launch" },
  // Chat, a conversation with a model (chat-fixtures.ts): `--out flow-chat`. A plain conversation
  // (a Markdown reply, no side pane), one that created items (with the pane), one that built a
  // workflow and a plugin, a run in flight with its live steps, a failed run, and a new chat.
  { name: "flow-chat-new", path: "/flow/org_personal/chat" },
  { name: "flow-chat", path: "/flow/org_personal/chat?chat=fchat_plain" },
  { name: "flow-chat-made-items", path: "/flow/org_personal/chat?chat=fchat_notes" },
  { name: "flow-chat-built", path: "/flow/org_personal/chat?chat=fchat_launch" },
  { name: "flow-chat-working", path: "/flow/org_personal/chat?chat=fchat_legal" },
  { name: "flow-chat-failed", path: "/flow/org_personal/chat?chat=fchat_slack" },
  // Team, Settings and All orgs (.kim/mockups/team-an-agent.html, all-orgs.html).
  // `--out flow-team` writes them there.
  { name: "team-agents", path: "/flow/org_personal/team?agent=fagt_backend" },
  { name: "team-runners", path: "/flow/org_personal/team?tab=runners" },
  { name: "team-people", path: "/flow/org_personal/team?tab=people" },
  { name: "settings-this-mac", path: "/flow/org_personal/settings" },
  { name: "settings-members", path: "/flow/org_personal/settings?tab=members" },
  { name: "all-orgs", path: "/flow/orgs" },
  { name: "search", path: "/flow/org_personal/p/fprj_api", keys: ["meta+k"] },
  // The inbox (.kim/mockups/inbox.html): `--out flow-inbox`.
  { name: "flow-inbox", path: "/flow/org_personal/inbox" },
  { name: "flow-inbox-decision", path: "/flow/org_personal/inbox?item=fitm_audit" },
  // The workflow editor and the Workflows list (workflow-editor.html): `--out flow-workflow`.
  {
    name: "flow-workflow",
    path: "/flow/org_personal/p/fprj_api?view=workflow",
    clicks: ['[data-testid="status-row"] > div:nth-child(3) [data-testid="status-box"]'],
  },
  {
    name: "flow-workflow-agent",
    path: "/flow/org_personal/p/fprj_api?view=workflow",
    clicks: ['[data-testid="status-row"] > div:nth-child(2) [data-testid="status-box"]'],
  },
  { name: "flow-workflows", path: "/flow/org_personal/workflows" },
  { name: "flow-workflows-edit", path: "/flow/org_personal/workflows?workflow=fwf_ship" },
  // Plugins, gateways, and plugin fields on cards and the item (plugins.html, gateways.html):
  // `--out flow-plugins`.
  { name: "flow-plugins", path: "/flow/org_personal/plugins" },
  { name: "flow-plugin-code", path: "/flow/org_personal/plugins?plugin=fplg_slack" },
  { name: "flow-gateways", path: "/flow/org_personal/plugins?tab=gateways" },
  {
    name: "flow-gateway-form",
    path: "/flow/org_personal/plugins?tab=gateways",
    clicks: ['[data-testid="connect-system"]'],
  },
  { name: "flow-fields", path: "/flow/org_personal/p/fprj_api?item=fitm_audit" },
  // A project's Settings and its repository: `--out flow-project-settings`.
  { name: "flow-project-settings", path: "/flow/org_personal/p/fprj_api?view=settings" },
  {
    name: "flow-project-settings-picker",
    path: "/flow/org_personal/p/fprj_launch?view=settings",
    pointerdowns: ['[data-testid="repo-picker"]'],
  },
  { name: "flow-project-settings-connect", path: "/flow/org_client/p/fprj_site?view=settings" },
  { name: "flow-gateways-github", path: "/flow/org_personal/plugins?tab=gateways" },
  // The run view (run.html) and the run line under an agent's summary (board-and-item-panel.html):
  // `--out flow-run`. The finished run with its first Bash step (the failing tests) chosen.
  {
    name: "flow-run-finished",
    path: "/flow/org_personal/p/fprj_api?run=frun_fitm_rate",
    clicks: ['[data-testid="step-list"] > :nth-child(7)'],
  },
  { name: "flow-run-live", path: "/flow/org_personal/p/fprj_api?run=frun_fitm_webhooks" },
  { name: "flow-run-failed", path: "/flow/org_personal/p/fprj_api?run=frun_fitm_postgres" },
  {
    name: "flow-run-line",
    path: "/flow/org_personal/p/fprj_api?item=fitm_rate",
    scrolls: ['[data-testid="open-run"][href*="frun_fitm_rate"]'],
  },
  // Auto's schedules (auto-schedules.html): `--out flow-auto`.
  { name: "flow-auto", path: "/flow/org_personal/auto" },
  {
    name: "flow-auto-new",
    path: "/flow/org_personal/auto",
    clicks: ['[data-testid="new-schedule"]'],
  },
  { name: "flow-auto-empty", path: "/flow/org_client/auto" },
  { name: "flow-auto-triggers", path: "/flow/org_personal/auto?tab=triggers" },
  // Update required (ADR 0393): full-window, in place of the shell, signed in or not.
  // `query` goes before the hash: a fresh page load the fake door reads (fake-bridge.ts).
  { name: "update-required-ready", path: "/", query: "?update=ready" },
  { name: "update-required-jobs", path: "/", query: "?update=jobs" },
  { name: "update-required-waiting", path: "/", query: "?update=waiting" },
  { name: "update-required-download", path: "/", query: "?update=download" },
  // The device key (spec 40 M4b, fake-bridge.ts `?key=`): the fingerprint while signing in, the
  // offer to sign in again with a Secure Enclave key, and a decision waiting for Touch ID.
  { name: "key-signing-in", path: "/", query: "?key=signing-in" },
  { name: "key-upgrade", path: "/", query: "?key=upgrade" },
  { name: "key-upgrade-this-mac", path: "/flow/org_personal/settings", query: "?key=upgrade" },
  { name: "key-touch-id", path: "/", query: "?key=touch-id" },
  {
    name: "key-sign-in-again-confirm",
    path: "/flow/org_personal/settings",
    query: "?key=upgrade",
    clicks: ['[data-testid="sign-in-again"]'],
  },
  // Check for updates on This Mac (spec 40 M4): the row in each state (fake-bridge.ts `?check=`).
  ...[
    "idle",
    "checking",
    "up-to-date",
    "downloading",
    "ready",
    "jobs",
    "offline",
    "refused",
    "not-installed",
    "off",
  ].map((check) => ({
    name: `this-mac-update-${check}`,
    path: "/flow/org_personal/settings",
    query: `?check=${check}`,
  })),
  // The window while the app loads (WindowSkeleton = index.html's static shell; `?session=slow`).
  { name: "loading-shell", path: "/", query: "?session=slow" },
  // Restart to update, step by step (fake-bridge.ts `?applying=`).
  { name: "updating-verifying", path: "/", query: "?applying=verifying" },
  { name: "updating-restarting", path: "/", query: "?applying=restarting" },
  { name: "updating-refused", path: "/", query: "?applying=refused" },
  // The app's error screen (an error no page handles; fake-bridge.ts `?crash=1`).
  { name: "app-error", path: "/", query: "?crash=1" },
];

const args = argv;
const valued = new Set(["--out", "--size", "--tag"]);
const only = args.filter((a, i) => !a.startsWith("--") && !valued.has(args[i - 1]));
const screens = only.length ? SCREENS.filter((s) => only.includes(s.name)) : SCREENS;

async function shoot(
  cdp,
  url,
  file,
  theme,
  keys = [],
  clicks = [],
  pointerdowns = [],
  scrolls = [],
) {
  await cdp.send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-color-scheme", value: theme }],
  });
  await cdp.send("Page.navigate", { url });
  await sleep(1600);
  for (const k of keys) {
    // "meta+k" holds ⌘; a bare key is typed as is.
    const meta = k.startsWith("meta+");
    const key = meta ? k.slice(5) : k;
    const ev = { key, code: `Key${key.toUpperCase()}`, modifiers: meta ? 4 : 0 };
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", ...ev });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...ev });
    await sleep(500);
  }
  for (const selector of clicks) {
    await cdp.send("Runtime.evaluate", {
      expression: `document.querySelector(${JSON.stringify(selector)})?.click()`,
    });
    await sleep(500);
  }
  // Radix opens a select or a menu on pointerdown, not click.
  for (const selector of pointerdowns) {
    await cdp.send("Runtime.evaluate", {
      expression: `document.querySelector(${JSON.stringify(selector)})?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }))`,
    });
    await sleep(500);
  }
  // `scrolls`: bring each element into the middle of its scrolling box before the shot.
  for (const selector of scrolls) {
    await cdp.send("Runtime.evaluate", {
      expression: `document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({ block: "center" })`,
    });
    await sleep(300);
  }
  const shot = await cdp.send("Page.captureScreenshot", {
    format: "png",
    clip: { x: 0, y: 0, width: W, height: H, scale: 1 },
  });
  writeFileSync(file, Buffer.from(shot.data, "base64"));
  console.log(`  ${file.replace(`${repo}/`, "")}`);
}

// SF_SHOTS_PORT moves the view's server (and the browser's debugging port beside it) when another
// session on the Mac already shoots on 5741.
const viewPort = Number(process.env.SF_SHOTS_PORT ?? 5741);
const server = await createServer({
  configFile: resolve(here, "vite.config.ts"),
  server: { port: viewPort, strictPort: true },
});
await server.listen();
const base = `http://localhost:${viewPort}/`;
const port = viewPort + 3592;
// A fresh browser profile per run: a kept one restores typed text and shows autofill previews
// (a Quick add once showed an earlier run's title as if it were its placeholder).
const profile = resolve(repo, `node_modules/.cache/sf-shots-chrome-${viewPort}`);
rmSync(profile, { recursive: true, force: true });
const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    `--remote-debugging-port=${port}`,
    `--window-size=${W},${H}`,
    "--hide-scrollbars",
    "--force-device-scale-factor=1",
    `--user-data-dir=${profile}`,
    "about:blank",
  ],
  { stdio: "ignore" },
);
try {
  const cdp = await connect(port);
  await cdp.send("Page.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: W,
    height: H,
    deviceScaleFactor: 1,
    mobile: false,
  });
  mkdirSync(out, { recursive: true });
  for (const s of screens) {
    for (const theme of ["light", "dark"]) {
      // A fresh view state per shot: one tab, the Personal org.
      await cdp.send("Page.navigate", { url: base });
      await sleep(300);
      await cdp.send("Runtime.evaluate", { expression: "localStorage.clear()" });
      const file = resolve(out, `${s.name}-${theme}${tag ? `-${tag}` : ""}.png`);
      await shoot(
        cdp,
        `${base}${s.query ?? ""}#${s.path}`,
        file,
        theme,
        s.keys,
        s.clicks,
        s.pointerdowns,
        s.scrolls,
      );
    }
  }
  cdp.close();
} finally {
  chrome.kill();
  await server.close();
}

// Screenshots of the desktop view (spec 41, criterion 11): serves the view with the fixture door
// (vite.config.ts here), drives Chrome headless over CDP at 1440×900, light and dark, and writes
// docs/screenshots/desktop-shell/<screen>-<theme>.png. `--design` also shoots each screen's design
// file to design/<file>.png, cropped to the window, for the side-by-side.
// `--out <dir>` writes under docs/screenshots/<dir> instead; `--size WxH` shoots at that size (the
// app's default window is 1200x800) and, with `--tag <t>`, names the files <screen>-<theme>-<t>.png.
//
//   node apps/desktop/screenshots/shoot.mjs [--design] [--out dir] [--size WxH --tag t] [screen ...]
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createServer } from "vite";

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

/** Each screen: its route, what to do before the shot, and its design file. */
export const SCREENS = [
  { name: "inbox-merge", path: "/?item=wi_13", design: "InboxMerge.html" },
  { name: "inbox-question", path: "/?item=wi_11", design: "InboxQuestion.html" },
  { name: "inbox-spec", path: "/?item=wi_12", design: "InboxMerge.html" },
  { name: "work-board", path: "/work", design: "WorkActive.html" },
  {
    name: "work-project",
    path: "/work?view=active&project=prj_factory",
    design: "WorkActive.html",
  },
  { name: "work-done", path: "/work?view=done", design: "WorkDone.html" },
  { name: "item-overview", path: "/work/wi_13", design: "ItemOverview.html" },
  // #9 has a live run with a takeover hint, so the header shows Pin, Open terminal and Cancel.
  { name: "item-header", path: "/work/wi_9", design: "ItemOverview.html" },
  { name: "item-plan", path: "/work/wi_12?tab=plan", design: "ItemPlan.html" },
  { name: "plan-focus", path: "/work/wi_12?tab=plan", design: "PlanFocus.html", keys: ["f"] },
  {
    name: "plan-focus-alone",
    path: "/work/wi_12?tab=plan&fixture=alone",
    design: "PlanFocus.html",
    keys: ["f"],
  },
  { name: "item-runs", path: "/work/wi_9?tab=runs", design: "ItemRuns.html" },
  { name: "item-review", path: "/work/wi_13?tab=review", design: "ItemReview.html" },
  { name: "item-activity", path: "/work/wi_13?tab=activity", design: "ItemActivity.html" },
  { name: "new-item", path: "/new", design: "WorkNew.html" },
  { name: "setup", path: "/setup", design: "Setup.html" },
  { name: "this-mac", path: "/settings", design: "SettingsDevices.html" },
  { name: "search", path: "/work", design: "Main.html", keys: ["meta+k"] },
  { name: "factory-overview", path: "/factory", design: "FactoryOverview.html" },
  { name: "factory-runners", path: "/factory/runners", design: "FactoryRunners.html" },
  { name: "factory-incidents", path: "/factory/incidents", design: "FactoryIncidents.html" },
  { name: "factory-policy", path: "/factory/policy", design: "FactoryPolicy.html" },
  { name: "factory-agents", path: "/factory/agents", design: "FactoryAgents.html" },
  { name: "factory-workflows", path: "/factory/workflows", design: "FactoryWorkflow.html" },
  // Update required (ADR 0393): full-window, in place of the shell, signed in or not.
  // `query` goes before the hash: a fresh page load the fake door reads (fake-bridge.ts).
  { name: "update-required-ready", path: "/", query: "?update=ready", design: "Main.html" },
  { name: "update-required-jobs", path: "/", query: "?update=jobs", design: "Main.html" },
  { name: "update-required-waiting", path: "/", query: "?update=waiting", design: "Main.html" },
  { name: "update-required-download", path: "/", query: "?update=download", design: "Main.html" },
];

const args = argv;
const withDesign = args.includes("--design");
const valued = new Set(["--out", "--size", "--tag"]);
const only = args.filter((a, i) => !a.startsWith("--") && !valued.has(args[i - 1]));
const screens = only.length ? SCREENS.filter((s) => only.includes(s.name)) : SCREENS;

/** A minimal CDP client over the browser's page websocket. */
async function connect(port) {
  for (let i = 0; i < 50; i++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = targets.find((t) => t.type === "page");
      if (page) {
        const ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((r, j) => {
          ws.onopen = r;
          ws.onerror = j;
        });
        let id = 0;
        const waiting = new Map();
        ws.onmessage = (m) => {
          const msg = JSON.parse(String(m.data));
          const w = waiting.get(msg.id);
          if (w) {
            waiting.delete(msg.id);
            if (msg.error) w.reject(new Error(msg.error.message));
            else w.resolve(msg.result);
          }
        };
        return {
          send: (method, params = {}) =>
            new Promise((resolve, reject) => {
              const n = ++id;
              waiting.set(n, { resolve, reject });
              ws.send(JSON.stringify({ id: n, method, params }));
            }),
          close: () => ws.close(),
        };
      }
    } catch {
      // Chrome is still starting.
    }
    await sleep(200);
  }
  throw new Error("Chrome didn't start");
}

async function shoot(cdp, url, file, theme, keys = [], clicks = []) {
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
const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    `--remote-debugging-port=${port}`,
    `--window-size=${W},${H}`,
    "--hide-scrollbars",
    "--force-device-scale-factor=1",
    `--user-data-dir=${resolve(repo, `node_modules/.cache/sf-shots-chrome-${viewPort}`)}`,
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
  mkdirSync(resolve(out, "design"), { recursive: true });
  for (const s of screens) {
    for (const theme of ["light", "dark"]) {
      // A fresh view state per shot: one tab, the Personal org.
      await cdp.send("Page.navigate", { url: base });
      await sleep(300);
      await cdp.send("Runtime.evaluate", { expression: "localStorage.clear()" });
      const file = resolve(out, `${s.name}-${theme}${tag ? `-${tag}` : ""}.png`);
      await shoot(cdp, `${base}${s.query ?? ""}#${s.path}`, file, theme, s.keys, s.clicks);
    }
  }
  if (withDesign) {
    const designs = [...new Set(screens.map((s) => s.design))];
    for (const d of designs) {
      const url = `file://${resolve(repo, "docs/design/factory-ui", d)}`;
      await shoot(cdp, url, resolve(out, "design", d.replace(".html", ".png")), "light");
    }
  }
  cdp.close();
} finally {
  chrome.kill();
  await server.close();
}

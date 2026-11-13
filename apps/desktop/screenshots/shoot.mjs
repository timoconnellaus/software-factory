// Screenshots of the desktop view (spec 41, criterion 11): serves the view with the fixture door
// (vite.config.ts here), drives Chrome headless over CDP at 1440×900, light and dark, and writes
// docs/screenshots/desktop-shell/<screen>-<theme>.png. `--design` also shoots each screen's design
// file to design/<file>.png, cropped to the window, for the side-by-side.
// `--out <dir>` writes under docs/screenshots/<dir> instead; `--size WxH` shoots at that size (the
// app's default window is 1200x800) and, with `--tag <t>`, names the files <screen>-<theme>-<t>.png.
//
//   node apps/desktop/screenshots/shoot.mjs [--design] [--out dir] [--size WxH --tag t] [screen ...]
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
    name: "plan-mockups",
    path: "/work/wi_12?tab=plan&pane=mockups",
    design: "PlanFocusMockup.html",
    keys: ["f"],
    storage: { "sf-mockups": "on" },
  },
  {
    name: "plan-canvas",
    path: "/work/wi_12?tab=plan&pane=canvas",
    design: "PlanFocus.html",
    keys: ["f"],
    storage: { "sf-mockups": "on" },
  },
  {
    name: "plan-focus-alone",
    path: "/work/wi_12?tab=plan&fixture=alone",
    design: "PlanFocus.html",
    keys: ["f"],
  },
  // Second review of #85: nested lists, a fence, kept edits and comments on each.
  {
    name: "plan-blocks",
    path: "/work/wi_12?tab=plan",
    design: "PlanFocus.html",
    keys: ["f"],
    scrollTo: "plan-block-comments",
  },
  {
    name: "plan-edits-dropped",
    path: "/work/wi_12?tab=plan&fixture=dropped",
    design: "PlanFocus.html",
    keys: ["f"],
    scrollTo: "your-edits",
  },
  // Spec 23 part C: the critic's notes at the spec gate.
  {
    name: "plan-critic",
    path: "/work/wi_12?tab=plan",
    design: "PlanFocus.html",
    keys: ["f"],
    clicks: ['[data-testid="critic-notes"]'],
  },
  // Review of #130: the files approving writes, one changed design opened (escaped, marked).
  {
    name: "plan-write-back",
    path: "/work/wi_12?tab=plan",
    design: "PlanFocus.html",
    keys: ["f"],
    clicks: ['[data-testid="write-back-file"]:nth-child(3) button'],
  },
  { name: "item-runs", path: "/work/wi_9?tab=runs", design: "ItemRuns.html" },
  { name: "item-review", path: "/work/wi_13?tab=review", design: "ItemReview.html" },
  // The factory's own checks and each criterion's proof (spec 51 PR B), below the fold.
  {
    name: "item-review-criteria",
    path: "/work/wi_13?tab=review",
    design: "ItemReview.html",
    scrollTo: "factory-checks",
  },
  // Honest proof at the gate (the owner's decision, 2026-11-13): no checks set up at all says so,
  // with no count; checks with every criterion proven; checks with some criteria tied to none.
  {
    name: "item-review-proof-no-checks",
    path: "/work/wi_13?tab=review&fixture=nochecks",
    design: "ItemReview.html",
    scrollTo: "criteria",
  },
  {
    name: "item-review-proof-all-proven",
    path: "/work/wi_13?tab=review&fixture=allproven",
    design: "ItemReview.html",
    scrollTo: "criteria",
  },
  {
    name: "item-review-proof-some-untied",
    path: "/work/wi_13?tab=review",
    design: "ItemReview.html",
    scrollTo: "criteria",
  },
  // Both kinds of tie: Proven (a person-approved spec) and passed the check triage named.
  {
    name: "item-review-proof-triage",
    path: "/work/wi_13?tab=review&fixture=triage",
    design: "ItemReview.html",
    scrollTo: "criteria",
  },
  { name: "inbox-merge-triage", path: "/?item=wi_13&fixture=triage", design: "InboxMerge.html" },
  {
    name: "inbox-merge-no-checks",
    path: "/?item=wi_13&fixture=nochecks",
    design: "InboxMerge.html",
  },
  // The runner could not run the checks (ADR 0501, third review): shown plainly, not passed.
  {
    name: "item-review-not-run",
    path: "/work/wi_13?tab=review&fixture=notrun",
    design: "ItemReview.html",
    scrollTo: "factory-checks",
  },
  // Fourth review: the decision when checks were not run (merge only without them, recorded).
  {
    name: "item-review-not-run-decision",
    path: "/work/wi_13?tab=review&fixture=notrun",
    design: "ItemReview.html",
    scrollTo: "decision",
  },
  { name: "item-activity", path: "/work/wi_13?tab=activity", design: "ItemActivity.html" },
  { name: "new-item", path: "/new", design: "WorkNew.html" },
  { name: "setup", path: "/setup", design: "Setup.html" },
  { name: "this-mac", path: "/settings", design: "SettingsDevices.html" },
  { name: "search", path: "/work", design: "Main.html", keys: ["meta+k"] },
  // The work model's screens (spec 50).
  { name: "backlog", path: "/work?view=backlog", design: "WorkBacklog.html" },
  {
    name: "backlog-selected",
    path: "/work?view=backlog",
    design: "WorkBacklog.html",
    clicks: ['[aria-label="Select #21"]', '[aria-label="Select #20"]'],
  },
  {
    name: "backlog-empty",
    path: "/work?view=backlog&project=prj_site",
    design: "WorkBacklog.html",
  },
  { name: "ready", path: "/work?view=ready", design: "WorkReady.html" },
  // Spec 52, Q4: a shaped item whose workflow's shaping changed waits on a person's choice. No
  // design of its own: it follows the Inbox's approval page.
  { name: "inbox-release-flag", path: "/?item=wi_16", design: "InboxQuestion.html" },
  { name: "planning-empty", path: "/work?view=planning", design: "WorkReady.html" },
  { name: "item-backlog", path: "/work/wi_21", design: "ItemBacklog.html" },
  { name: "item-ready-blocked", path: "/work/wi_site_2", design: "ItemBacklog.html" },
  { name: "item-queued", path: "/work/wi_28", design: "ItemBacklog.html" },
  {
    name: "item-edit",
    path: "/work/wi_21",
    design: "ItemBacklog.html",
    clicks: ['[data-testid="edit-item"]'],
  },
  { name: "work-new", path: "/new", design: "WorkNew.html" },
  // A project whose config defines workflows and names none: captured, never released.
  { name: "work-new-no-workflow", path: "/new?project=prj_crm", design: "WorkNew.html" },
  { name: "project", path: "/work?project=prj_factory", design: "WorkProject.html" },
  // In the factory and Done (spec 41 slice 2).
  { name: "board", path: "/work?view=active&project=prj_factory", design: "WorkActive.html" },
  {
    name: "board-list",
    path: "/work?view=active&project=prj_factory&layout=list",
    design: "WorkActive.html",
  },
  { name: "board-empty", path: "/work?view=active&project=prj_site", design: "WorkActive.html" },
  { name: "active-all", path: "/work", design: "WorkActiveAll.html" },
  { name: "active-all-list", path: "/work?layout=list", design: "WorkActiveAll.html" },
  { name: "done", path: "/work?view=done", design: "WorkDone.html" },
  // The item side panel (spec 41 slice 7): over the board, over the All projects list, on the
  // Plan tab, and on an item before release.
  {
    name: "panel-board",
    path: "/work?view=active&project=prj_factory&item=wi_9",
    design: "WorkActivePanel.html",
  },
  {
    name: "panel-all-review",
    path: "/work?item=wi_13&itemTab=review",
    design: "WorkActivePanel.html",
  },
  {
    name: "panel-plan",
    path: "/work?view=active&project=prj_factory&item=wi_12&itemTab=plan",
    design: "WorkActivePanel.html",
  },
  { name: "panel-backlog", path: "/work?view=backlog&item=wi_21", design: "WorkActivePanel.html" },
  // The terminal docked inside the panel, on the fixture door's made-up session (never a real
  // shell). Shot to docs/screenshots/desktop-terminal with `--out desktop-terminal`.
  {
    name: "board-panel",
    path: "/work?view=active&project=prj_factory&item=wi_9&end=1",
    query: "?terminal=fixture",
    design: "WorkActivePanel.html",
    clicks: ['[data-testid="item-panel"] [data-testid="open-terminal"]'],
  },
  { name: "factory-overview", path: "/factory", design: "FactoryOverview.html" },
  { name: "factory-runners", path: "/factory/runners", design: "FactoryRunners.html" },
  { name: "factory-incidents", path: "/factory/incidents", design: "FactoryIncidents.html" },
  { name: "factory-policy", path: "/factory/policy", design: "FactoryPolicy.html" },
  { name: "factory-agents", path: "/factory/agents", design: "FactoryAgents.html" },
  { name: "factory-workflows", path: "/factory/workflows", design: "FactoryWorkflow.html" },
  {
    name: "settings-repositories",
    path: "/settings/repositories",
    design: "SettingsProjects.html",
  },
  {
    name: "settings-connections",
    path: "/settings/connections",
    design: "SettingsConnections.html",
  },
  { name: "settings-devices", path: "/settings/devices", design: "SettingsDevices.html" },
  // Update required (ADR 0393): full-window, in place of the shell, signed in or not.
  // `query` goes before the hash: a fresh page load the fake door reads (fake-bridge.ts).
  { name: "update-required-ready", path: "/", query: "?update=ready", design: "Main.html" },
  { name: "update-required-jobs", path: "/", query: "?update=jobs", design: "Main.html" },
  { name: "update-required-waiting", path: "/", query: "?update=waiting", design: "Main.html" },
  { name: "update-required-download", path: "/", query: "?update=download", design: "Main.html" },
  // Check for updates on This Mac (spec 40 M4): the row in each state (fake-bridge.ts `?check=`).
  {
    name: "this-mac-update-idle",
    path: "/settings",
    query: "?check=idle",
    design: "SettingsDevices.html",
  },
  {
    name: "this-mac-update-checking",
    path: "/settings",
    query: "?check=checking",
    design: "SettingsDevices.html",
  },
  {
    name: "this-mac-update-up-to-date",
    path: "/settings",
    query: "?check=up-to-date",
    design: "SettingsDevices.html",
  },
  {
    name: "this-mac-update-downloading",
    path: "/settings",
    query: "?check=downloading",
    design: "SettingsDevices.html",
  },
  {
    name: "this-mac-update-ready",
    path: "/settings",
    query: "?check=ready",
    design: "SettingsDevices.html",
  },
  {
    name: "this-mac-update-jobs",
    path: "/settings",
    query: "?check=jobs",
    design: "SettingsDevices.html",
  },
  {
    name: "this-mac-update-offline",
    path: "/settings",
    query: "?check=offline",
    design: "SettingsDevices.html",
  },
  {
    name: "this-mac-update-refused",
    path: "/settings",
    query: "?check=refused",
    design: "SettingsDevices.html",
  },
  {
    name: "this-mac-update-off",
    path: "/settings",
    query: "?check=off",
    design: "SettingsDevices.html",
  },
];

const args = argv;
const withDesign = args.includes("--design");
const valued = new Set(["--out", "--size", "--tag"]);
const only = args.filter((a, i) => !a.startsWith("--") && !valued.has(args[i - 1]));
const screens = only.length ? SCREENS.filter((s) => only.includes(s.name)) : SCREENS;

async function shoot(cdp, url, file, theme, keys = [], clicks = [], scrollTo = null) {
  await cdp.send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-color-scheme", value: theme }],
  });
  // A fixture variant is read once per page load: load it afresh for each theme.
  if (url.includes("fixture=")) await cdp.send("Page.navigate", { url: "about:blank" });
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
  if (scrollTo) {
    // Bring a part of the view into sight (a test id), centred.
    await cdp.send("Runtime.evaluate", {
      expression: `document.querySelector('[data-testid="${scrollTo}"]')?.scrollIntoView({ block: "center" })`,
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
  mkdirSync(resolve(out, "design"), { recursive: true });
  for (const s of screens) {
    for (const theme of ["light", "dark"]) {
      // A fresh view state per shot: one tab, the Personal org.
      await cdp.send("Page.navigate", { url: base });
      await sleep(300);
      await cdp.send("Runtime.evaluate", {
        // A screen may set per-device settings first (e.g. mockups on, spec 21).
        expression: `localStorage.clear(); ${Object.entries(s.storage ?? {})
          .map(([k, v]) => `localStorage.setItem(${JSON.stringify(k)}, ${JSON.stringify(v)});`)
          .join(" ")}`,
      });
      const file = resolve(out, `${s.name}-${theme}${tag ? `-${tag}` : ""}.png`);
      await shoot(
        cdp,
        `${base}${s.query ?? ""}#${s.path}`,
        file,
        theme,
        s.keys,
        s.clicks,
        s.scrollTo,
      );
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

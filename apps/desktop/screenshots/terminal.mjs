// Screenshots of Open terminal (spec 42) with a real terminal: starts a tmux session of its own on
// the `sf-shot` socket (never the factory's `software-factory` socket, so no job is touched), serves
// the real view with the fixture door and the harness's relay (vite.config.ts bridges the pane with
// runner-local's control-mode bridge), opens the terminal in Chrome, types into it, and writes
// docs/screenshots/desktop-terminal/<shot>-<theme>.png. Kills its tmux session at the end.
//
//   node apps/desktop/screenshots/terminal.mjs
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const here = import.meta.dirname;
const repo = resolve(here, "../../..");
const out = resolve(repo, "docs/screenshots/desktop-terminal");
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const W = 1440;
const H = 900;
const SOCKET = "sf-shot";
const SESSION = "sf-demo";

const tmux = (...args) => execFileSync("tmux", ["-L", SOCKET, "-f", "/dev/null", ...args]);
const { TMUX: _, TMUX_PANE: __, ...env } = process.env;

/** A fresh shell in its own tmux session, with some output on screen. */
async function freshSession() {
  try {
    tmux("kill-session", "-t", `=${SESSION}`);
  } catch {
    // not there
  }
  execFileSync(
    "tmux",
    [
      "-L",
      SOCKET,
      "-f",
      "/dev/null",
      "new-session",
      "-d",
      "-s",
      SESSION,
      "-x",
      "140",
      "-y",
      "34",
      "-c",
      repo,
      "zsh",
      "-f",
      "-i",
    ],
    { env: { ...env, PROMPT: "%F{green}runner%f %1~ %# " } },
  );
  await sleep(600);
  tmux(
    "send-keys",
    "-t",
    `=${SESSION}:`,
    "git --no-pager log --oneline -6 --no-decorate && ls packages",
    "Enter",
  );
  await sleep(800);
}
process.env.SF_SHOT_TMUX_SESSION = SESSION;
process.env.SF_SHOT_TMUX_SOCKET = SOCKET;
const { createServer } = await import("vite");

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
            new Promise((ok, fail) => {
              const n = ++id;
              waiting.set(n, { resolve: ok, reject: fail });
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

const server = await createServer({ configFile: resolve(here, "vite.config.ts") });
await server.listen();
const base = "http://localhost:5741/";
const port = 9334;
const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    `--remote-debugging-port=${port}`,
    `--window-size=${W},${H}`,
    "--hide-scrollbars",
    "--force-device-scale-factor=1",
    `--user-data-dir=${resolve(repo, "node_modules/.cache/sf-shots-terminal-chrome")}`,
    "about:blank",
  ],
  { stdio: "ignore" },
);

/** Each shot: the page, the terminal's mode, what to do once it's open. `--before` shoots the
 * button as it was (run with the old open-terminal.tsx checked out) for the PR's before/after. */
const BEFORE = [{ name: "before-build", path: "/work/wi_9" }];
const SHOTS_AFTER = [
  { name: "build-owner", path: "/work/wi_9", type: "echo typed in the desktop app\r" },
  { name: "build-expanded", path: "/work/wi_9", type: "date\r", expand: true },
  { name: "build-watcher", path: "/work/wi_9", mode: "watch" },
  { name: "build-unavailable", path: "/work/wi_9", mode: "none", attachInstead: true },
  { name: "plan-focus", path: "/work/wi_12?tab=plan", keys: ["f"], type: "pwd\r" },
];
const SHOTS = process.argv.includes("--before") ? BEFORE : SHOTS_AFTER;

try {
  const cdp = await connect(port);
  await cdp.send("Page.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: W,
    height: H,
    deviceScaleFactor: 1,
    mobile: false,
  });
  const js = (expression) => cdp.send("Runtime.evaluate", { expression, awaitPromise: true });
  const click = (testid) => js(`document.querySelector('[data-testid="${testid}"]')?.click()`);
  mkdirSync(out, { recursive: true });
  for (const s of SHOTS) {
    for (const theme of ["light", "dark"]) {
      await freshSession();
      await cdp.send("Page.navigate", { url: base });
      await sleep(300);
      await js("localStorage.clear()");
      await cdp.send("Emulation.setEmulatedMedia", {
        features: [{ name: "prefers-color-scheme", value: theme }],
      });
      await cdp.send("Page.navigate", { url: `${base}?terminal=${s.mode ?? "type"}#${s.path}` });
      await sleep(1600);
      for (const key of s.keys ?? []) {
        const ev = { key, code: `Key${key.toUpperCase()}` };
        await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", ...ev });
        await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...ev });
        await sleep(500);
      }
      await click("open-terminal");
      await sleep(2000);
      if (s.expand) {
        await click("terminal-expand");
        await sleep(800);
      }
      if (s.type) {
        // Typed as a person would, into the terminal (xterm.js's own textarea has the focus).
        for (const ch of s.type) {
          if (ch === "\r") {
            const ev = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" };
            await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", ...ev });
            await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...ev });
          } else {
            await cdp.send("Input.insertText", { text: ch });
          }
          await sleep(15);
        }
        await sleep(1200);
      }
      if (s.attachInstead) {
        await click("attach-instead");
        await sleep(500);
      }
      const shot = await cdp.send("Page.captureScreenshot", {
        format: "png",
        clip: { x: 0, y: 0, width: W, height: H, scale: 1 },
      });
      const file = resolve(out, `${s.name}-${theme}.png`);
      writeFileSync(file, Buffer.from(shot.data, "base64"));
      console.log(`  ${file.replace(`${repo}/`, "")}`);
      // Close it as a person would (Esc outside the terminal), so the next shot starts clean.
      await click("terminal-close");
      await sleep(300);
    }
  }
  cdp.close();
} finally {
  chrome.kill();
  await server.close();
  try {
    tmux("kill-session", "-t", `=${SESSION}`);
  } catch {
    // gone
  }
}

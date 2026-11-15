// The live harness: the desktop view in headless Chrome, as shoot.mjs serves it, but with the live
// bridge (live-bridge.ts): its operations go to the REAL engine with the `sf` CLI's token, so the
// screens show the signed-in person's real org. It is how an agent looks at real screens with real
// data (the installed app's window can't be driven). A manual tool: it needs `sf login` and the
// engine, so it never runs in CI.
//
//   node apps/desktop/screenshots/live.mjs shots [--out <dir>] [--dark] [--size WxH] [route ...]
//   node apps/desktop/screenshots/live.mjs run <script.mjs> [--out <dir>] [--dark]
//
// - The token stays in this process. The view posts its calls to `/__live/*` on the dev server,
//   which forwards them to the engine's CLI door (`/cli/v1/call`, `/cli/v1/batch`) and adds the
//   token there; it is never sent to the browser, printed, or written anywhere.
// - Read-only unless `--write`: a call whose operation the engine's own listing (`/cli/v1/ops`)
//   doesn't mark `read` is refused here, before it reaches the engine.
// - Images go to a new directory in the OS temp dir (they hold real data; the repo is public).
//   `--out` picks another; one inside the repo must be git-ignored.
// - For each route it prints console errors, failed requests and failed operations, and exits 1 if
//   there were any: a screen that renders while an operation fails is what this is for.
// - `run` imports the script and calls its default export with the helpers (go, click, type, press,
//   waitForText, text, shot, evaluate); a script can also import them from this file.
// SF_LIVE_PORT moves the view's server off 5781 (Chrome's debugging port is 3592 above it).
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { createServer } from "vite";
import { connect } from "./cdp.mjs";

const here = import.meta.dirname;
const repo = resolve(here, "../../..");
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const DEFAULT_URL = "https://sf-engine.zerobsai.com";

// ---------------------------------------------------------------------------------------------
// The engine, as the CLI reaches it (local/cli/src/config.ts): SF_TOKEN and SF_URL override the
// config file, which is $SF_CONFIG or $XDG_CONFIG_HOME/software-factory/cli.json.

function cliSettings() {
  const env = process.env;
  const file =
    env.SF_CONFIG ??
    join(
      env.XDG_CONFIG_HOME ?? join(env.HOME ?? homedir(), ".config"),
      "software-factory",
      "cli.json",
    );
  let config = {};
  try {
    config = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    // No config: SF_TOKEN may still be set.
  }
  const token = env.SF_TOKEN?.trim() || config.token || null;
  if (!token) throw new Error(`not signed in: run \`sf login\` (no token in ${file} or SF_TOKEN)`);
  const url = (env.SF_URL || config.url || DEFAULT_URL).replace(/\/+$/, "");
  return { url, login: config.login ?? null, token };
}

/** The token lives only in this closure; nothing returns or logs it. */
function engineClient() {
  const { url, login, token } = cliSettings();
  async function engine(path, body) {
    const res = await fetch(`${url}/cli/v1/${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { error: text.trim().slice(0, 200) };
    }
    return { status: res.status, json };
  }
  return { url, login, engine };
}

// ---------------------------------------------------------------------------------------------
// What went wrong, per route: printed after each one, and the exit code.

const problems = [];
let current = "setup";
function problem(kind, text) {
  const line = `${kind}: ${text}`;
  if (problems.some((p) => p.route === current && p.line === line)) return; // a poll repeats it
  problems.push({ route: current, line });
}

// ---------------------------------------------------------------------------------------------
// The proxy: the view's `call`, `batch` and `decide`, forwarded with the token.

function proxy({ engine, url, login, risks, write }) {
  /** A refusal of anything that isn't a read, unless `--write`. */
  function guard(op) {
    const risk = risks.get(op);
    if (write || risk === "read") return null;
    const error = `live.mjs is read-only: ${op} is ${risk ? `a ${risk} operation` : "not an operation the engine lists"} (--write allows writes)`;
    problem("refused write", error);
    return { ok: false, code: "read_only", error };
  }
  const failed = (op, r) => {
    if (!r.ok) problem("operation error", `${op}: ${r.code}: ${r.error}`);
    return r;
  };

  async function call({ op, input, idempotencyKey }) {
    const refused = guard(op);
    if (refused) return refused;
    const { status, json } = await engine("call", {
      op,
      input: input ?? {},
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });
    if (status === 202 && json.pending)
      return {
        ok: false,
        code: "pending",
        error: `held for approval (${json.pendingActionId ?? ""})`,
      };
    if (status < 300 && json && "result" in json) return { ok: true, result: json.result };
    return failed(op, {
      ok: false,
      code: String(json.code ?? `http_${status}`),
      error: String(json.error ?? `the engine answered ${status}`),
      ...(json.details !== undefined ? { details: json.details } : {}),
    });
  }

  async function batch({ calls }) {
    const out = calls.map((c) => guard(c.op));
    const send = calls.filter((_, i) => !out[i]);
    if (send.length) {
      const { status, json } = await engine("batch", { calls: send });
      const results = Array.isArray(json.results)
        ? json.results
        : send.map(() => ({ ok: false, code: json.code ?? `http_${status}`, error: json.error }));
      let j = 0;
      for (let i = 0; i < calls.length; i++) {
        if (out[i]) continue;
        const r = results[j++] ?? { ok: false, code: "unavailable", error: "no answer" };
        out[i] = r.ok
          ? { ok: true, result: r.result }
          : failed(calls[i].op, { ok: false, code: String(r.code), error: String(r.error) });
      }
    }
    return out;
  }

  async function decide({ op }) {
    const refused = guard(op);
    if (refused) return refused;
    return failed(op, {
      ok: false,
      code: "unsupported",
      error: "a decision needs the device key and Touch ID: do it in the app",
    });
  }

  const routes = {
    "/session": async () => ({ login, engineUrl: url }),
    "/call": call,
    "/batch": batch,
    "/decide": decide,
  };
  const plugin = {
    name: "live-proxy",
    configureServer(server) {
      server.middlewares.use("/__live", async (req, res) => {
        const route = routes[req.url ?? ""];
        let answer;
        if (req.method !== "POST" || !route) {
          res.statusCode = 404;
          answer = { ok: false, code: "not_found", error: "not found" };
        } else {
          try {
            let body = "";
            for await (const chunk of req) body += chunk;
            answer = await route(body ? JSON.parse(body) : {});
          } catch (error) {
            // Never the request's headers: only what failed.
            const message = error instanceof Error ? error.message : String(error);
            problem("proxy error", message);
            answer = { ok: false, code: "unavailable", error: message };
          }
        }
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(answer));
      });
    },
  };
  return { plugin, batch };
}

// ---------------------------------------------------------------------------------------------
// The browser and the helpers a run script uses.

let cdp = null;
let base = "";
let outDir = "";
let theme = "light";
let size = [1440, 900];
let fresh = true;

const evaluate = async (expression) => {
  const r = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? expression);
  return r.result.value;
};

/**
 * Wait until the screen settles: no request to the engine in flight and no skeleton showing, twice
 * in a row. Gives up after `cap` ms and says so (a screen that never settles is worth knowing).
 */
export async function settle(cap = 15_000) {
  const until = Date.now() + cap;
  let quiet = 0;
  let last = null;
  await sleep(400);
  while (Date.now() < until) {
    last = await evaluate(`(() => ({
      main: !!document.querySelector("main"),
      pending: window.__sfLivePending?.() ?? 0,
      skeletons: [...document.querySelectorAll(".animate-pulse")].filter((e) => e.getClientRects().length).length,
    }))()`);
    quiet = last.main && last.pending === 0 && last.skeletons === 0 ? quiet + 1 : 0;
    if (quiet >= 3) return true;
    await sleep(250);
  }
  problem(
    "never settled",
    `after ${cap / 1000}s: ${last?.pending ?? "?"} requests in flight, ${last?.skeletons ?? "?"} skeletons`,
  );
  return false;
}

/** Open a route (`/flow/<org>/inbox`) in a fresh view and wait for it to settle. */
export async function go(path) {
  current = path;
  if (fresh) {
    // A fresh view state: one tab, the org the route names.
    await cdp.send("Page.navigate", { url: base });
    await sleep(300);
    await evaluate("localStorage.clear()");
    fresh = false;
  }
  await cdp.send("Page.navigate", { url: `${base}#${path}` });
  await settle();
}

/** The element a helper means: a `data-testid`, a CSS selector, or an element's visible text. */
function find(target) {
  return `(() => {
    const t = ${JSON.stringify(target)};
    const byId = document.querySelector('[data-testid="' + CSS.escape(t) + '"]');
    if (byId) return byId;
    try { const bySel = document.querySelector(t); if (bySel) return bySel; } catch {}
    const visible = (e) => e.getClientRects().length > 0;
    const clickable = 'button, a, [role=tab], [role=button], [role=menuitem], [role=option], label, input, textarea, [contenteditable=true]';
    const said = (e) => (e.textContent ?? "").replace(/\\s+/g, " ").trim();
    const fields = [...document.querySelectorAll("input, textarea, [contenteditable=true]")].filter(visible);
    const field = fields.find((e) => e.placeholder === t || e.getAttribute("aria-label") === t);
    if (field) return field;
    const all = [...document.querySelectorAll(clickable)].filter(visible);
    return all.find((e) => said(e) === t) ?? all.find((e) => said(e).includes(t))
      ?? [...document.querySelectorAll("body *")].filter(visible).reverse().find((e) => said(e) === t)
      ?? null;
  })()`;
}

async function centre(target) {
  const box = await evaluate(`(() => {
    const e = ${find(target)};
    if (!e) return null;
    e.scrollIntoView({ block: "center" });
    const r = e.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`);
  if (!box) throw new Error(`nothing on ${current} matches ${JSON.stringify(target)}`);
  return box;
}

/** Click what a person would: a `data-testid`, a selector, or visible text. Real mouse events. */
export async function click(target) {
  const { x, y } = await centre(target);
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"])
    await cdp.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
  await settle();
}

/** Type into a field (a `data-testid`, a selector, its placeholder or its label), replacing it. */
export async function type(target, text) {
  await click(target);
  await evaluate(`(() => { const e = document.activeElement; if (e?.select) e.select(); })()`);
  await cdp.send("Input.insertText", { text });
  await sleep(150);
}

/** Press a key (`Enter`, `Escape`, `k` with `{ meta: true }`). */
export async function press(key, { meta = false } = {}) {
  const code = key.length === 1 ? `Key${key.toUpperCase()}` : key;
  const keyCode = { Escape: 27, Enter: 13, Tab: 9 }[key] ?? 0;
  const ev = { key, code, modifiers: meta ? 4 : 0, windowsVirtualKeyCode: keyCode };
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", ...ev });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...ev });
  await settle();
}

/** Wait for text to show anywhere on the page. */
export async function waitForText(text, ms = 10_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await evaluate(`document.body.innerText.includes(${JSON.stringify(text)})`)) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${JSON.stringify(text)} on ${current}`);
}

/** The visible text of an element (`data-testid`, selector or text), or null. */
export const text = (target) => evaluate(`${find(target)}?.innerText ?? null`);

/** Save the window as `<name>.png` in the output directory; returns its path. */
export async function shot(name) {
  const [width, height] = size;
  const png = await cdp.send("Page.captureScreenshot", {
    format: "png",
    clip: { x: 0, y: 0, width, height, scale: 1 },
  });
  const file = resolve(outDir, `${name.replace(/[^\w.-]+/g, "-")}.png`);
  writeFileSync(file, Buffer.from(png.data, "base64"));
  return file;
}

export { evaluate };

// ---------------------------------------------------------------------------------------------
// The default walk through the real org.

async function defaultRoutes(read) {
  const { orgs } = await read("org.list", {});
  const org = orgs[0]?.id;
  if (!org) throw new Error("the signed-in person has no orgs");
  const f = `/flow/${org}`;
  const routes = [
    { name: "all-orgs", path: "/flow/orgs" },
    { name: "inbox", path: `${f}/inbox` },
  ];
  const { projects } = await read("flow.project.list", { orgId: org });
  const items = [];
  for (const p of projects) {
    const slug = p.key.toLowerCase();
    const at = `${f}/p/${p.id}`;
    routes.push(
      { name: `${slug}-board`, path: at },
      { name: `${slug}-list`, path: `${at}?view=list` },
      { name: `${slug}-workflow`, path: `${at}?view=workflow` },
      { name: `${slug}-settings`, path: `${at}?view=settings` },
    );
    const board = await read("flow.board.get", { orgId: org, projectId: p.id }).catch(() => null);
    const mine = (board?.columns ?? []).flatMap((c) => c.items ?? []).slice(0, 3);
    for (const it of mine) {
      const name = `${slug}-${it.number}`;
      items.push({ ...it, at });
      routes.push(
        { name: `${name}-panel`, path: `${at}?item=${it.id}` },
        { name: `${name}-page`, path: `${at}/i/${it.id}` },
      );
    }
  }
  // The newest run of those items, finished if one is, in the run view.
  const runs = [];
  for (const it of items.slice(0, 10)) {
    const r = await read("flow.run.list", { orgId: org, itemId: it.id, limit: 3 }).catch(
      () => null,
    );
    for (const run of r?.runs ?? []) runs.push({ ...run, at: it.at });
  }
  const when = (r) => r.endedAt ?? r.finishedAt ?? r.updatedAt ?? r.createdAt ?? "";
  runs.sort((a, b) => String(when(b)).localeCompare(String(when(a))));
  const run = runs.find((r) => r.status !== "running" && r.status !== "queued") ?? runs[0];
  if (run) routes.push({ name: "run", path: `${run.at}?run=${run.id}` });
  const { chats } = await read("flow.chat.list", { orgId: org });
  routes.push({ name: "chats", path: `${f}/chat` });
  const newest = [...chats].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  if (newest) routes.push({ name: "chat", path: `${f}/chat?chat=${newest.id}` });
  routes.push(
    { name: "team-agents", path: `${f}/team` },
    { name: "team-runners", path: `${f}/team?tab=runners` },
    { name: "team-people", path: `${f}/team?tab=people` },
    { name: "auto", path: `${f}/auto` },
    { name: "auto-triggers", path: `${f}/auto?tab=triggers` },
    { name: "workflows", path: `${f}/workflows` },
    { name: "plugins", path: `${f}/plugins` },
    { name: "gateways", path: `${f}/plugins?tab=gateways` },
    { name: "settings", path: `${f}/settings` },
    { name: "settings-members", path: `${f}/settings?tab=members` },
  );
  return routes;
}

// ---------------------------------------------------------------------------------------------

function outputDir(argv) {
  const i = argv.indexOf("--out");
  if (i < 0) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    return join(tmpdir(), `sf-live-${stamp}`);
  }
  const dir = resolve(process.cwd(), argv[i + 1] ?? "");
  const inRepo = !relative(repo, dir).startsWith("..");
  if (inRepo) {
    let ignored = false;
    try {
      execFileSync("git", ["-C", repo, "check-ignore", "-q", dir], { stdio: "ignore" });
      ignored = true;
    } catch {
      ignored = false;
    }
    if (!ignored)
      throw new Error(
        `${dir} is in the repo and not git-ignored: these images hold real data and the repo is public`,
      );
  }
  return dir;
}

function report(route) {
  const mine = problems.filter((p) => p.route === route);
  for (const p of mine) console.log(`    ! ${p.line}`);
}

async function main() {
  const argv = process.argv.slice(2);
  const [command, ...rest] = argv;
  if (command !== "shots" && command !== "run") {
    console.log(
      "usage: live.mjs shots [--out dir] [--dark] [--size WxH] [route ...]\n       live.mjs run <script.mjs> [--out dir] [--dark]",
    );
    process.exit(2);
  }
  const write = rest.includes("--write");
  theme = rest.includes("--dark") ? "dark" : "light";
  const sizeAt = rest.indexOf("--size");
  if (sizeAt >= 0) size = rest[sizeAt + 1].split("x").map(Number);
  const valued = new Set(["--out", "--size"]);
  const positional = rest.filter((a, i) => !a.startsWith("--") && !valued.has(rest[i - 1]));
  outDir = outputDir(rest);
  mkdirSync(outDir, { recursive: true });

  const { engine, url, login } = engineClient();
  const listing = await engine("ops");
  if (listing.status !== 200 || !Array.isArray(listing.json.operations))
    throw new Error(
      `the engine's operation listing failed (${listing.status}): ${listing.json.error ?? "no answer"}`,
    );
  const risks = new Map(listing.json.operations.map((o) => [o.name, o.risk]));
  const live = proxy({ engine, url, login, risks, write });
  console.log(
    `live: ${url} as ${login ?? "the CLI's token"}, ${write ? "WRITES ALLOWED" : "read-only"}, ${theme}`,
  );

  const viewPort = Number(process.env.SF_LIVE_PORT ?? 5781);
  const server = await createServer({
    configFile: resolve(here, "vite.config.ts"),
    mode: "live",
    plugins: [live.plugin],
    server: { port: viewPort, strictPort: true, host: "127.0.0.1" },
  });
  await server.listen();
  base = `http://127.0.0.1:${viewPort}/`;
  const port = viewPort + 3592;
  const profile = join(tmpdir(), `sf-live-chrome-${viewPort}`);
  rmSync(profile, { recursive: true, force: true });
  const [W, H] = size;
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
    cdp = await connect(port);
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Network.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: W,
      height: H,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await cdp.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-color-scheme", value: theme }],
    });
    cdp.on("Runtime.consoleAPICalled", (e) => {
      if (e.type !== "error" && e.type !== "assert") return;
      const said = e.args.map((a) => a.value ?? a.description ?? "").join(" ");
      problem("console error", said.split("\n")[0].slice(0, 300));
    });
    cdp.on("Runtime.exceptionThrown", (e) => {
      const d = e.exceptionDetails;
      problem("uncaught", (d.exception?.description ?? d.text ?? "").split("\n")[0].slice(0, 300));
    });
    cdp.on("Network.loadingFailed", (e) => {
      if (!e.canceled) problem("request failed", `${e.errorText} (${e.type})`);
    });
    cdp.on("Network.responseReceived", (e) => {
      // The view has no favicon; Chrome asks anyway.
      if (e.response.status >= 400 && !e.response.url.endsWith("/favicon.ico"))
        problem("request failed", `${e.response.status} ${e.response.url.replace(base, "/")}`);
    });

    // A plain fetch through the proxy, as the view's reads go: setup problems are reported too.
    const read = async (op, input) => {
      const [r] = await live.batch({ calls: [{ op, input }] });
      if (!r.ok) throw new Error(`${op}: ${r.code}: ${r.error}`);
      return r.result;
    };

    if (command === "shots") {
      const routes = positional.length
        ? positional.map((path) => ({
            // The path without its org (every route has the same one): `p-fprj_x-view-list`.
            name: path.replace(/^\/flow\/(org_[^/]+\/)?/, "").replace(/[^\w]+/g, "-"),
            path,
          }))
        : await defaultRoutes(read);
      report("setup");
      console.log(`  ${routes.length} routes -> ${outDir}`);
      for (const [i, r] of routes.entries()) {
        await go(r.path);
        const file = await shot(`${String(i + 1).padStart(2, "0")}-${r.name}`);
        console.log(`  ${r.path}\n    ${file.replace(`${outDir}/`, "")}`);
        report(r.path);
      }
    } else {
      const script = positional[0];
      if (!script) throw new Error("run needs a script: live.mjs run <script.mjs>");
      const mod = await import(pathToFileURL(resolve(process.cwd(), script)).href);
      if (typeof mod.default === "function")
        await mod.default({ go, click, type, press, waitForText, text, shot, settle, evaluate });
      for (const route of new Set(problems.map((p) => p.route))) {
        console.log(`  ${route}`);
        report(route);
      }
      console.log(`  images in ${outDir}`);
    }
    cdp.close();
  } finally {
    chrome.kill();
    await server.close();
  }
  const routesWith = new Set(problems.map((p) => p.route)).size;
  console.log(
    problems.length
      ? `\n${problems.length} problems on ${routesWith} routes`
      : "\nno console errors, failed requests or operation errors",
  );
  process.exit(problems.length ? 1 : 0);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`live: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}

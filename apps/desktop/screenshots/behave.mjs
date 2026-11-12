// Behaviour tests of the desktop view (spec 50 UI): the real view, built as the screenshot harness
// builds it (vite.config.ts, the fixture door), driven in headless Chrome over CDP. They click,
// type and press keys as a person would and check what the view does and which operations it
// sends (the fake door records every write in `window.__sfCalls`). They need Chrome, so they run on
// a Mac (`pnpm --filter @software-factory/desktop behave`), not in CI's workerd tests.
//
//   node apps/desktop/screenshots/behave.mjs [name-filter]
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createServer } from "vite";
import { connect } from "./cdp.mjs";

const here = import.meta.dirname;
const repo = resolve(here, "../../..");
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const filter = process.argv[2];

/** What a test gets: the page, and small helpers that act as a person would. */
function page(cdp, base) {
  const evaluate = async (expression) => {
    const r = await cdp.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails)
      throw new Error(r.exceptionDetails.exception?.description ?? expression);
    return r.result.value;
  };
  const $ = (selector) => `document.querySelector(${JSON.stringify(selector)})`;
  const p = {
    evaluate,
    /** A fresh view at a path: one tab, nothing remembered, no writes recorded. */
    async open(path) {
      await cdp.send("Page.navigate", { url: base });
      await sleep(200);
      await evaluate("localStorage.clear()");
      await cdp.send("Page.navigate", { url: `${base}#${path}` });
      await p.waitFor("document.querySelector('main') !== null");
      await sleep(400);
    },
    async waitFor(expression, ms = 3000) {
      const until = Date.now() + ms;
      while (Date.now() < until) {
        if (await evaluate(`!!(${expression})`)) return;
        await sleep(50);
      }
      throw new Error(`timed out waiting for ${expression}`);
    },
    exists: (selector) => evaluate(`${$(selector)} !== null`),
    text: (selector) => evaluate(`${$(selector)}?.textContent ?? null`),
    click: (selector) => evaluate(`${$(selector)}.click()`),
    /** Two clicks in one task, as a fast double-click lands before React re-renders. */
    doubleClick: (selector) =>
      evaluate(`(() => { const e = ${$(selector)}; e.click(); e.click(); })()`),
    focus: (selector) => evaluate(`${$(selector)}.focus()`),
    type: (text) => cdp.send("Input.insertText", { text }),
    async key(key, modifiers = 0) {
      const code = key.length === 1 ? `Key${key.toUpperCase()}` : key;
      const keyCode = { Escape: 27, Enter: 13, Tab: 9 }[key] ?? 0;
      const ev = { key, code, modifiers, windowsVirtualKeyCode: keyCode };
      await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", ...ev });
      await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...ev });
      await sleep(150);
    },
    calls: (op) =>
      evaluate(`(window.__sfCalls ?? []).filter((c) => c.op === ${JSON.stringify(op)})`),
    path: () => evaluate("location.hash.slice(1)"),
    toasts: () =>
      evaluate("[...document.querySelectorAll('[data-sonner-toast]')].map((t) => t.textContent)"),
  };
  return p;
}

function expect(actual, label) {
  const fail = (want) => {
    throw new Error(`${label}: expected ${want}, got ${JSON.stringify(actual)}`);
  };
  return {
    toBe: (v) => actual === v || fail(JSON.stringify(v)),
    toContain: (v) => (actual ?? "").includes(v) || fail(`to contain ${JSON.stringify(v)}`),
    toBeTruthy: () => !!actual || fail("truthy"),
    toBeFalsy: () => !actual || fail("falsy"),
  };
}

const checked = (p, label) =>
  p.evaluate(`document.querySelector('[aria-label="${label}"]')?.getAttribute("data-state")`);

/** The tests, in order. Each opens its own fresh view. */
export const TESTS = [
  {
    name: "bulk release: every refusal is reported and the refused item stays selected",
    async run(p) {
      await p.open("/work?view=backlog");
      await p.click('[aria-label="Select every item"]');
      await p.click('[data-testid="release-selected"]');
      await p.waitFor(
        "(window.__sfCalls ?? []).filter((c) => c.op === 'workItem.release').length === 5",
      );
      await p.waitFor("document.querySelector('[data-sonner-toast]') !== null");
      const toasts = (await p.toasts()).join(" | ");
      expect(toasts, "the report").toContain("Released 4 items to the factory.");
      expect(toasts, "the report").toContain("Not released: work item #20 needs a repository");
      expect(await checked(p, "Select #20"), "#20, refused").toBe("checked");
      expect(await checked(p, "Select #21"), "#21, released").toBe("unchecked");
    },
  },
  {
    name: "bulk actions: a double click sends one set of calls",
    async run(p) {
      await p.open("/work?view=backlog");
      await p.click('[aria-label="Select #21"]');
      await p.doubleClick('[data-testid="mark-ready-selected"]');
      await sleep(600);
      expect((await p.calls("workItem.move")).length, "moves sent").toBe(1);
      await p.click('[aria-label="Select #21"]');
      await p.click('[aria-label="Select #22"]');
      await p.doubleClick('[data-testid="release-selected"]');
      await sleep(1200);
      // One release per selected item, once: a second click would send four.
      expect((await p.calls("workItem.release")).length, "releases sent").toBe(2);
    },
  },
  {
    name: "quick add: read-only while adding, and Enter twice adds once",
    async run(p) {
      await p.open("/work?view=backlog");
      await p.focus('[data-testid="quick-add"]');
      await p.type("One more thing");
      await p.key("Enter");
      expect(
        await p.evaluate("document.querySelector('[data-testid=quick-add]').readOnly"),
        "read-only while adding",
      ).toBe(true);
      await p.key("Enter");
      await sleep(600);
      expect((await p.calls("workItem.create")).length, "creates sent").toBe(1);
      expect(
        await p.evaluate("document.querySelector('[data-testid=quick-add]').value"),
        "cleared once added",
      ).toBe("");
    },
  },
  {
    name: "edit: Esc with unsaved edits asks first, and keeps what was typed",
    async run(p) {
      await p.open("/work/wi_21");
      await p.click('[data-testid="edit-item"]');
      await p.waitFor("document.querySelector('#edit-title') !== null");
      await p.focus("#edit-title");
      await p.evaluate("document.querySelector('#edit-title').select()");
      await p.type("A better title");
      await p.key("Escape");
      expect(
        await p.exists('[data-testid="discard-dialog"]'),
        "asks before discarding",
      ).toBeTruthy();
      // The question opens with an animation; focus moves into it once it has.
      await sleep(300);
      await p.key("Escape");
      await sleep(300);
      expect(await p.exists('[data-testid="discard-dialog"]'), "the question closes").toBeFalsy();
      expect(await p.exists('[data-testid="edit-dialog"]'), "the edit stays open").toBeTruthy();
      expect(
        await p.evaluate("document.querySelector('#edit-title').value"),
        "the typed title",
      ).toBe("A better title");
      await p.key("Escape");
      await p.click('[data-testid="discard"]');
      await sleep(300);
      expect(await p.exists('[data-testid="edit-dialog"]'), "discarded").toBeFalsy();
    },
  },
];

const viewPort = Number(process.env.SF_SHOTS_PORT ?? 5751);
const server = await createServer({
  configFile: resolve(here, "vite.config.ts"),
  server: { port: viewPort, strictPort: true },
});
await server.listen();
const base = `http://localhost:${viewPort}/`;
const port = viewPort + 3592;
const profile = resolve(repo, `node_modules/.cache/sf-behave-chrome-${viewPort}`);
rmSync(profile, { recursive: true, force: true });
const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    `--remote-debugging-port=${port}`,
    "--window-size=1200,800",
    `--user-data-dir=${profile}`,
    "about:blank",
  ],
  { stdio: "ignore" },
);
let failed = 0;
try {
  const cdp = await connect(port);
  await cdp.send("Page.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1200,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  });
  const p = page(cdp, base);
  for (const t of TESTS.filter((t) => !filter || t.name.includes(filter))) {
    try {
      await t.run(p);
      console.log(`  ✓ ${t.name}`);
    } catch (e) {
      failed++;
      console.log(`  ✗ ${t.name}\n      ${e instanceof Error ? e.message : e}`);
    }
  }
  cdp.close();
} finally {
  chrome.kill();
  await server.close();
}
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);

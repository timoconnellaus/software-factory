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
    /**
     * A fresh view at a path: one tab, nothing remembered, no writes recorded. `query` goes before
     * the hash (the fake door reads it: `?terminal=fixture`); the hash history then glues it onto
     * the last hash param, so paths that take one end with `&end=1`.
     */
    async open(path, query = "") {
      await cdp.send("Page.navigate", { url: base });
      await sleep(200);
      await evaluate("localStorage.clear()");
      await cdp.send("Page.navigate", { url: `${base}${query}#${path}` });
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
    /** Which element has the keyboard, as `[data-testid]`, `[data-peek]` or the tag. */
    focused: () =>
      evaluate(
        "(() => { const e = document.activeElement; return e?.dataset?.testid ?? (e?.dataset?.peek ? 'peek:' + e.dataset.peek : e?.tagName); })()",
      ),
    inPanel: () =>
      evaluate(
        "!!document.querySelector('[data-testid=item-panel]')?.contains(document.activeElement)",
      ),
    panelOpen: () => evaluate("!!document.querySelector('[data-testid=item-panel]')"),
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
    not: {
      toContain: (v) => !(actual ?? "").includes(v) || fail(`not to contain ${JSON.stringify(v)}`),
    },
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
  {
    name: "panel: Esc closes the dialog, then the terminal, then the panel",
    async run(p) {
      await p.open("/work?view=active&project=prj_factory&item=wi_9&end=1", "?terminal=fixture");
      await p.waitFor("document.querySelector('[data-testid=panel-body]')");
      await p.click('[data-testid="item-panel"] [data-testid="cancel"]');
      await p.waitFor("document.querySelector('[role=dialog]')");
      await sleep(300);
      await p.key("Escape");
      await sleep(300);
      expect(await p.exists("[role=dialog]"), "the dialog closes").toBeFalsy();
      expect(await p.panelOpen(), "the panel stays").toBeTruthy();
      await p.click('[data-testid="item-panel"] [data-testid="open-terminal"]');
      await p.waitFor("document.querySelector('[data-testid=terminal-dock]')");
      await p.focus('[data-testid="item-panel"]');
      await p.key("Escape");
      await sleep(200);
      expect(await p.exists('[data-testid="terminal-dock"]'), "the terminal closes").toBeFalsy();
      expect(await p.panelOpen(), "the panel stays").toBeTruthy();
      await p.key("Escape");
      await sleep(300);
      expect(await p.panelOpen(), "then the panel closes").toBeFalsy();
    },
  },
  {
    name: "panel: Esc while typing keeps the panel and the typed text",
    async run(p) {
      await p.open("/work?view=active&project=prj_factory&item=wi_12&itemTab=plan");
      await p.waitFor("document.querySelector('[data-testid=chat-strip]')", 5000);
      await p.click('[data-testid="chat-strip"]');
      await p.waitFor("document.querySelector('[data-testid=chat-input]')");
      await p.focus('[data-testid="chat-input"]');
      await p.type("half a thought");
      await p.key("Escape");
      await sleep(200);
      expect(await p.panelOpen(), "the panel stays").toBeTruthy();
      expect(
        await p.evaluate("document.querySelector('[data-testid=chat-input]').value"),
        "the typed text",
      ).toContain("half a thought");
    },
  },
  {
    name: "panel: deep link, reload, back and forward; closing doesn't leave a way back into it",
    async run(p) {
      await p.open("/work?view=active&project=prj_factory&item=wi_9");
      expect(await p.panelOpen(), "a deep link opens it").toBeTruthy();
      await p.evaluate("location.reload()");
      await sleep(1500);
      expect(await p.panelOpen(), "a reload keeps it").toBeTruthy();
      await p.open("/work?view=active&project=prj_factory");
      await p.click('[data-testid="card-wi_9"]');
      await p.waitFor("document.querySelector('[data-testid=item-panel]')");
      expect(await p.path(), "the URL names it").toContain("item=wi_9");
      await p.evaluate("history.back()");
      await sleep(500);
      expect(await p.panelOpen(), "back closes it").toBeFalsy();
      await p.evaluate("history.forward()");
      await sleep(500);
      expect(await p.panelOpen(), "forward opens it again").toBeTruthy();
      await p.click('[data-testid="panel-close"]');
      await sleep(400);
      expect(await p.panelOpen(), "closed").toBeFalsy();
      await p.evaluate("history.back()");
      await sleep(500);
      expect(await p.path(), "back after closing").not.toContain("item=wi_9");
    },
  },
  {
    name: "panel: opening moves focus into it, Tab stays inside, closing returns it to the card",
    async run(p) {
      await p.open("/work?view=active&project=prj_factory");
      await p.focus('[data-testid="card-wi_9"]');
      await p.key("Enter");
      await p.waitFor("document.querySelector('[data-testid=panel-body]')");
      await sleep(200);
      expect(await p.inPanel(), "focus moved in").toBeTruthy();
      for (let i = 0; i < 40; i++) await p.key("Tab");
      expect(await p.inPanel(), "Tab stays inside").toBeTruthy();
      await p.click('[data-testid="panel-close"]');
      await sleep(400);
      expect(await p.focused(), "back on the card").toBe("card-wi_9");
      expect(
        await p.evaluate("document.querySelectorAll('main').length"),
        "one main landmark with it open",
      ).toBe(1);
    },
  },
  {
    name: "panel: closing it, or showing another item, releases the terminal's socket",
    async run(p) {
      await p.open("/work?view=active&project=prj_factory&item=wi_9&end=1", "?terminal=fixture");
      await p.waitFor(
        "document.querySelector('[data-testid=item-panel] [data-testid=open-terminal]')",
      );
      await p.click('[data-testid="item-panel"] [data-testid="open-terminal"]');
      await p.waitFor("(window.__sfCalls ?? []).some((c) => c.op === 'terminal.open')");
      await sleep(300);
      await p.click('[data-testid="panel-close"]');
      await sleep(400);
      const [opened] = await p.calls("terminal.open");
      const closed = await p.calls("terminal.close");
      expect(closed.length, "closed once").toBe(1);
      expect(closed[0]?.input.id, "the same socket").toBe(opened?.input.id);
      // Another item in the panel: the first one's terminal goes.
      await p.click('[data-testid="card-wi_9"]');
      await p.waitFor(
        "document.querySelector('[data-testid=item-panel] [data-testid=open-terminal]')",
      );
      await p.click('[data-testid="item-panel"] [data-testid="open-terminal"]');
      await p.waitFor(
        "(window.__sfCalls ?? []).filter((c) => c.op === 'terminal.open').length === 2",
      );
      await sleep(300);
      await p.click('[data-testid="card-wi_26"]');
      await sleep(400);
      expect((await p.calls("terminal.close")).length, "released on item change").toBe(2);
    },
  },
  {
    name: "panel: Expand keeps the tab and an open terminal",
    async run(p) {
      await p.open(
        "/work?view=active&project=prj_factory&item=wi_9&itemTab=runs&end=1",
        "?terminal=fixture",
      );
      await p.waitFor(
        "document.querySelector('[data-testid=item-panel] [data-testid=open-terminal]')",
      );
      await p.click('[data-testid="item-panel"] [data-testid="open-terminal"]');
      await p.waitFor("document.querySelector('[data-testid=terminal-dock]')");
      await p.click('[data-testid="panel-expand"]');
      await sleep(800);
      expect(await p.path(), "the item's page").toContain("/work/wi_9");
      expect(await p.path(), "the same tab").toContain("tab=runs");
      expect(
        await p.exists('[data-testid="terminal-dock"]'),
        "the terminal stays open",
      ).toBeTruthy();
    },
  },
  {
    name: "panel: at 1200 wide it leaves the board readable, and resizes from its left edge",
    async run(p) {
      await p.open("/work?view=active&project=prj_factory&item=wi_9");
      const w = Number(
        await p.evaluate("document.querySelector('[data-testid=item-panel]').dataset.width"),
      );
      expect(w <= 480 && w >= 360, `width ${w} between 360 and half the content area`).toBeTruthy();
      await p.focus('[data-testid="panel-resize"]');
      await p.key("ArrowRight");
      const narrower = Number(
        await p.evaluate("document.querySelector('[data-testid=item-panel]').dataset.width"),
      );
      expect(narrower < w, `narrower after ArrowRight (${narrower})`).toBeTruthy();
      expect(await p.evaluate("localStorage.getItem('sf.itemPanel.width')"), "remembered").toBe(
        String(narrower),
      );
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

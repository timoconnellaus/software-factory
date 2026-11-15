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
    cdp,
    base,
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

/** A switch's state ("checked", "unchecked"), by its test id. */
const checked = (p, testId) =>
  p.evaluate(`document.querySelector('[data-testid="${testId}"]')?.dataset.state`);

/** The router's own error screen, which must never show (the app's is `app-error`). */
const ROUTER_ERROR = "document.body.textContent.includes('Something went wrong!')";

/** The new core's board (spec 70): an item on the board as `?item=`. */
const FLOW_BOARD = "/flow/org_personal/p/fprj_api";

/** The tests, in order. Each opens its own fresh view. */
export const TESTS = [
  {
    name: "app: a fresh window opens on the new shell, with no way into the old screens",
    async run(p) {
      await p.cdp.send("Page.navigate", { url: "about:blank" });
      await p.cdp.send("Page.navigate", { url: p.base });
      await p.waitFor("document.querySelector('[data-testid=board]')");
      expect(await p.path(), "the window's place").toContain("/flow/org_personal/p/fprj_api");
      expect(await p.exists("[data-testid=status-bar]"), "no status bar").toBeFalsy();
      expect(await p.exists("[data-testid=flow-nav-old-factory]"), "no Old factory").toBeFalsy();
      // The old screens' paths land on the new shell.
      for (const old of ["/work", "/factory", "/settings/repositories", "/setup", "/work/wi_13"]) {
        await p.evaluate(`location.hash = '#${old}'`);
        await sleep(500);
        expect(await p.evaluate(ROUTER_ERROR), `no router error at ${old}`).toBeFalsy();
        expect(await p.exists("[data-testid=flow-shell]"), `the shell at ${old}`).toBeTruthy();
      }
    },
  },
  {
    name: "flow: a card opens the item panel; Done on the decision card finishes it",
    async run(p) {
      await p.open(FLOW_BOARD);
      await p.click('[data-testid=board-card][href*="fitm_rate"]');
      await p.waitFor("document.querySelector('[data-testid=decision-card]')");
      await p.click("[data-testid=jump-to-decision]");
      await p.click("[data-testid=decision-primary]");
      await sleep(600);
      const calls = await p.calls("flow.item.finish");
      expect(calls.length, "one finish").toBe(1);
      expect(calls[0].input.outcome, "done").toBe("done");
      expect(calls[0].input.itemId, "this item").toBe("fitm_rate");
    },
  },
  {
    name: "flow: Reject on a decision sends flow.item.decide, Retry on a stopped item sends retry",
    async run(p) {
      await p.open(`${FLOW_BOARD}?item=fitm_audit`);
      await p.waitFor("document.querySelector('[data-testid=decision-secondary]')");
      await p.click("[data-testid=decision-secondary]");
      await sleep(600);
      const decide = await p.calls("flow.item.decide");
      expect(decide[0]?.input.decision, "reject").toBe("reject");
      await p.open(`${FLOW_BOARD}?item=fitm_postgres`);
      await p.waitFor("document.querySelector('[data-testid=retry]')");
      await p.click("[data-testid=retry]");
      await sleep(600);
      expect((await p.calls("flow.item.retry")).length, "one retry").toBe(1);
    },
  },
  {
    name: "flow: + makes an item with its title and body",
    async run(p) {
      await p.open(FLOW_BOARD);
      await p.click("[data-testid=new-item]");
      await p.waitFor("document.querySelector('#item-title')");
      await p.focus("#item-title");
      await p.type("Add a status page");
      await p.focus("#item-body");
      await p.type("One page, every service.");
      await p.click("[data-testid=create-item]");
      await sleep(700);
      const made = await p.calls("flow.item.create");
      expect(made[0]?.input.title, "title").toBe("Add a status page");
      expect(made[0]?.input.body, "body").toBe("One page, every service.");
      expect(made[0]?.input.projectId, "project").toBe("fprj_api");
    },
  },
  {
    name: "loading: the shell fills the window, its toolbar strip drags it, at the toolbar's height",
    async run(p) {
      await p.cdp.send("Page.navigate", { url: `${p.base}?session=slow#/` });
      await p.waitFor("document.querySelector('[data-testid=window-skeleton]')");
      for (const [w, h] of [
        [1200, 800],
        [760, 1100],
      ]) {
        await p.cdp.send("Emulation.setDeviceMetricsOverride", {
          width: w,
          height: h,
          deviceScaleFactor: 1,
          mobile: false,
        });
        await sleep(100);
        const box = await p.evaluate(
          "(() => { const r = document.querySelector('[data-testid=window-skeleton]').getBoundingClientRect(); return [r.width, r.height]; })()",
        );
        expect(box.join("x"), `the shell at ${w}x${h}`).toBe(`${w}x${h}`);
      }
      await p.cdp.send("Emulation.setDeviceMetricsOverride", {
        width: 1200,
        height: 800,
        deviceScaleFactor: 1,
        mobile: false,
      });
      const strip = await p.evaluate(
        "(() => { const e = document.querySelector('[data-testid=toolbar-skeleton]'); return [e.classList.contains('electrobun-webkit-app-region-drag'), e.getBoundingClientRect().height]; })()",
      );
      expect(strip[0], "the drag region").toBe(true);
      expect(strip[1], "the toolbar's height").toBe(44);
    },
  },
  {
    name: "sign-in: completing it with a route mounted shows the app, not an error screen",
    async run(p) {
      await p.open(FLOW_BOARD, "?session=out");
      expect(await p.exists("[data-testid=sign-in]"), "the sign-in screen").toBeTruthy();
      expect(await p.evaluate(ROUTER_ERROR), "no router error while signed out").toBeFalsy();
      await p.evaluate("window.__sfSignIn()");
      await p.waitFor("document.querySelector('[data-testid=toolbar]')");
      await p.waitFor("document.querySelector('[data-testid=board]')");
      expect(await p.evaluate(ROUTER_ERROR), "no router error after signing in").toBeFalsy();
      expect(
        await p.exists("[data-testid=app-error]"),
        "no app error after signing in",
      ).toBeFalsy();
    },
  },
  {
    name: "sign-in: the token ending mid-session (device replaced) leads to sign-in, then back",
    async run(p) {
      await p.open(FLOW_BOARD);
      await p.waitFor("document.querySelector('[data-testid=toolbar]')");
      await p.evaluate("window.__sfRevoke()");
      // A read refused as signed out on the way, as the old token's next call would be.
      await p.evaluate("location.hash = '#/flow/org_personal/team'");
      await p.waitFor("document.querySelector('[data-testid=sign-in]')");
      await sleep(300);
      expect(await p.evaluate(ROUTER_ERROR), "no router error once signed out").toBeFalsy();
      expect(await p.exists("[data-testid=app-error]"), "no app error once signed out").toBeFalsy();
      await p.evaluate("window.__sfSignIn()");
      await p.waitFor("document.querySelector('[data-testid=toolbar]')");
      await sleep(300);
      expect(await p.evaluate(ROUTER_ERROR), "no router error signed in again").toBeFalsy();
      expect(await p.exists("[data-testid=app-error]"), "no app error signed in again").toBeFalsy();
    },
  },
  {
    name: "errors: an unexpected one lands on the app's error screen, with Retry and Reload",
    async run(p) {
      await p.open("/", "?crash=1");
      await p.waitFor("document.querySelector('[data-testid=app-error]')");
      expect(await p.evaluate(ROUTER_ERROR), "not the router's default").toBeFalsy();
      expect(await p.text("[data-testid=app-error] h1"), "its heading").toContain(
        "Something went wrong",
      );
      expect(await p.text("[data-testid=app-error]"), "its buttons").toContain("Retry");
      expect(await p.text("[data-testid=app-error]"), "its buttons").toContain("Reload");
      // Under the traffic lights, the strip still moves the window.
      expect(
        await p.exists("[data-testid=app-error] .electrobun-webkit-app-region-drag"),
        "the drag strip",
      ).toBeTruthy();
    },
  },
  {
    name: "team: editing an agent's instructions saves them with its name and tools",
    async run(p) {
      await p.open("/flow/org_personal/team?agent=fagt_lead");
      await p.waitFor("document.querySelector('[data-testid=agent-instructions]')");
      await p.focus("[data-testid=agent-instructions]");
      await p.evaluate(
        "(() => { const t = document.querySelector('[data-testid=agent-instructions]'); t.setSelectionRange(t.value.length, t.value.length); })()",
      );
      await p.type(" Keep it short.");
      await p.waitFor("document.querySelector('[data-testid=save-instructions]')");
      await p.click("[data-testid=save-instructions]");
      await sleep(700);
      const saved = await p.calls("flow.agent.update");
      expect(saved.length, "one update").toBe(1);
      expect(saved[0].input.agentId, "this agent").toBe("fagt_lead");
      expect(saved[0].input.name, "its name kept").toBe("Lead");
      expect(saved[0].input.instructions, "the new instructions").toContain("Keep it short.");
      expect(JSON.stringify(saved[0].input.mcp), "its tools kept").toBe("[]");
    },
  },
  {
    name: "team: the Plugin editor switch sends mcp factory, and off sends none",
    async run(p) {
      await p.open("/flow/org_personal/team?agent=fagt_qa");
      await p.waitFor("document.querySelector('[data-testid=plugin-editor]')");
      expect(await checked(p, "plugin-editor"), "off at first").toBe("unchecked");
      await p.click("[data-testid=plugin-editor]");
      await sleep(700);
      let sent = await p.calls("flow.agent.update");
      expect(JSON.stringify(sent[0]?.input.mcp), "on").toBe('["factory"]');
      expect(sent[0]?.input.instructions, "instructions kept").toContain("Check the change");
      await p.open("/flow/org_personal/team?agent=fagt_backend");
      await p.waitFor("document.querySelector('[data-testid=plugin-editor]')");
      expect(await checked(p, "plugin-editor"), "Backend has it").toBe("checked");
      await p.click("[data-testid=plugin-editor]");
      await sleep(700);
      sent = await p.calls("flow.agent.update");
      expect(JSON.stringify(sent[0]?.input.mcp), "off").toBe("[]");
    },
  },
  {
    name: "team: New agent makes one with its name and instructions",
    async run(p) {
      await p.open("/flow/org_personal/team");
      await p.click("[data-testid=new-agent]");
      await p.waitFor("document.querySelector('#agent-name')");
      await p.focus("#agent-name");
      await p.type("Docs");
      await p.focus("#new-agent-instructions");
      await p.type("Write the docs.");
      await p.click("[data-testid=create-agent]");
      await sleep(700);
      const made = await p.calls("flow.agent.create");
      expect(made[0]?.input.name, "name").toBe("Docs");
      expect(made[0]?.input.instructions, "instructions").toBe("Write the docs.");
      expect(await p.path(), "shows the new agent").toContain("agent=fagt_new");
    },
  },
  {
    name: "team: Runners and People are tabs; Settings has This Mac and Members",
    async run(p) {
      await p.open("/flow/org_personal/team");
      await p.evaluate(
        "[...document.querySelectorAll('[data-testid=section-tabs] [role=tab]')].find((t) => t.textContent === 'Runners').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))",
      );
      await p.waitFor("document.querySelector('[data-testid=runner-row]')");
      expect(await p.path(), "the tab in the URL").toContain("tab=runners");
      expect(await p.text("[data-testid=runners]"), "plain words").toContain("Takes new work");
      await p.open("/flow/org_personal/settings");
      await p.waitFor("document.querySelector('[data-testid=runner-status]')");
      expect(await p.text("[data-testid=runner-status]"), "the runner").toContain("Running");
      expect(await p.text("[data-testid=installed]"), "the version").toContain("0.1.41");
      await p.click("[data-testid=settings-sign-out]");
      await p.waitFor("document.querySelector('[data-testid=settings-page]')");
      await p.open("/flow/org_personal/settings?tab=members");
      await p.waitFor("document.querySelector('[data-testid=member]')");
      expect(await p.text("[data-testid=members]"), "a real name").toContain("Sam Lee");
    },
  },
  {
    name: "all orgs: Open on what needs you goes to the item in its org",
    async run(p) {
      await p.open("/flow/org_personal/work");
      await p.click("[data-testid=all-orgs]");
      await p.waitFor("document.querySelector('[data-testid=need-row]')");
      expect(await p.text("[data-testid=needs-you]"), "across orgs").toContain("Client");
      await p.evaluate(
        "[...document.querySelectorAll('[data-testid=need-row]')].find((r) => r.textContent.includes('Invoice footer')).querySelector('[data-testid=open-item]').click()",
      );
      await p.waitFor("document.querySelector('[data-testid=item-panel]')");
      expect(await p.path(), "the item on its board").toBe(
        "/flow/org_client/p/fprj_site?item=fitm_footer",
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

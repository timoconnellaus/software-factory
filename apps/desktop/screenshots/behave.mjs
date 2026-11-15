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
    reads: (op) =>
      evaluate(`(window.__sfReads ?? []).filter((c) => c.op === ${JSON.stringify(op)})`),
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
    name: "flow inbox: the decision comes first; acting on it sends it and moves to the next row",
    async run(p) {
      await p.open("/flow/org_personal/inbox");
      await p.waitFor("document.querySelector('[data-testid=inbox-item] [data-testid=led-here]')");
      const first = await p.evaluate(
        "(() => { const d = document.querySelector('[data-testid=inbox-item]'); const c = d.querySelector('[data-testid=decision-card]'); const l = d.querySelector('[data-testid=led-here]'); return !!(c.compareDocumentPosition(l) & Node.DOCUMENT_POSITION_FOLLOWING); })()",
      );
      expect(first, "the decision card before what led here").toBe(true);
      expect(await p.text("[data-testid=inbox-row][aria-current=true]"), "the first row").toContain(
        "Add rate limiting",
      );
      await p.click("[data-testid=decision-primary]");
      await sleep(900);
      const calls = await p.calls("flow.item.finish");
      expect(calls.length, "one finish").toBe(1);
      expect(calls[0].input.itemId, "this item").toBe("fitm_rate");
      expect(calls[0].input.outcome, "done").toBe("done");
      expect(await p.path(), "the next row").toContain("item=fitm_audit");
      await p.waitFor("document.querySelector('[data-testid=decision-card][data-kind=decision]')");
      await p.click("[data-testid=decision-secondary]");
      await sleep(900);
      const decide = await p.calls("flow.item.decide");
      expect(decide[0]?.input.itemId, "the decision's item").toBe("fitm_audit");
      expect(decide[0]?.input.decision, "reject").toBe("reject");
    },
  },
  {
    name: "flow workflow: add, rename, reorder, edit and remove statuses, then Save sends it whole",
    async run(p) {
      await p.open("/flow/org_personal/p/fprj_api?view=workflow");
      await p.waitFor("document.querySelector('[data-testid=status-editor]')");
      const boxes = () =>
        p.evaluate(
          "[...document.querySelectorAll('[data-testid=status-box-name]')].map((e) => e.textContent)",
        );
      await p.click("[data-testid=add-status]");
      await p.waitFor("document.querySelectorAll('[data-testid=status-box]').length === 6");
      await p.evaluate("document.querySelector('#status-name').select()");
      await p.type("Deploy");
      await p.click("[data-testid=move-left]");
      expect((await boxes()).join(","), "Deploy before Shipped").toBe(
        "Spec,Build,Review,Approve,Deploy,Shipped",
      );
      // Review no longer needs a decision.
      await p.click("[data-testid=status-row] > div:nth-child(3) [data-testid=status-box]");
      await p.click("[data-testid=status-needs-decision]");
      // Spec goes.
      await p.click("[data-testid=status-row] > div:nth-child(1) [data-testid=status-box]");
      await p.click("[data-testid=remove-status]");
      expect((await boxes()).join(","), "Spec removed").toBe("Build,Review,Approve,Deploy,Shipped");
      await p.click("[data-testid=save-workflow]");
      await sleep(900);
      const saved = await p.calls("flow.workflow.update");
      expect(saved.length, "one save").toBe(1);
      const { input } = saved[0];
      expect(input.workflowId, "this workflow").toBe("fwf_ship");
      expect(input.name, "its name").toBe("Ship a feature");
      expect(input.statuses.map((s) => s.id).join(","), "ids, the new one from its name").toBe(
        "build,review,approve,deploy,shipped",
      );
      expect(input.statuses[1].needsDecision, "Review's decision off").toBe(false);
      expect(input.statuses[0].owner.agentId, "owners kept").toBe("fagt_backend");
    },
  },
  {
    name: "flow workflow: a problem the server finds shows beside the status it names",
    async run(p) {
      await p.open("/flow/org_personal/p/fprj_api?view=workflow");
      await p.waitFor("document.querySelector('[data-testid=status-editor]')");
      await p.click("[data-testid=status-row] > div:nth-child(2) [data-testid=status-box]");
      await p.evaluate("document.querySelector('#status-name').select()");
      await p.type(" ");
      await p.click("[data-testid=save-workflow]");
      await sleep(900);
      expect((await p.calls("flow.workflow.update")).length, "sent").toBe(1);
      expect(await p.text("[data-testid=status-problem]"), "in the status's editor").toBe(
        "A status needs a name.",
      );
      expect(
        await p.exists("[data-testid=status-row] > div:nth-child(2) [data-testid=box-problem]"),
        "under its box",
      ).toBe(true);
      expect(await p.exists("[data-testid=workflow-problem]"), "not the workflow's").toBe(false);
    },
  },
  {
    name: "flow plugins: a switch turns a plugin off, and Delete deletes it",
    async run(p) {
      await p.open("/flow/org_personal/plugins");
      await p.waitFor("document.querySelector('[data-testid=plugin-switch]')");
      await p.click("[data-testid=plugin-switch]");
      await sleep(700);
      const set = await p.calls("flow.plugin.setEnabled");
      expect(set[0]?.input.name, "the first plugin, by name").toBe("Publish to the blog");
      expect(set[0]?.input.enabled, "off").toBe(false);
      await p.click("[data-testid=open-plugin]");
      await p.waitFor("document.querySelector('[data-testid=plugin-code]')");
      await p.click("[data-testid=delete-plugin]");
      await p.waitFor("document.querySelector('[data-testid=confirm-delete-plugin]')");
      await p.click("[data-testid=confirm-delete-plugin]");
      await sleep(700);
      const deleted = await p.calls("flow.plugin.delete");
      expect(deleted[0]?.input.name, "deleted, by name").toBe("Publish to the blog");
      expect(await p.exists("[data-testid=plugin-panel]"), "closed").toBe(false);
    },
  },
  {
    name: "flow gateways: Connect a system sends the secret once, and it is never shown again",
    async run(p) {
      await p.open("/flow/org_personal/plugins?tab=gateways");
      await p.waitFor("document.querySelector('[data-testid=connect-system]')");
      await p.click("[data-testid=connect-system]");
      await p.waitFor("document.querySelector('#gateway-name')");
      await p.focus("#gateway-name");
      await p.type("Linear");
      await p.focus("#gateway-url");
      await p.type("https://api.linear.app");
      await p.focus("#gateway-secret");
      await p.type("lin_s3cret_value");
      await p.click("[data-testid=save-gateway]");
      await sleep(900);
      const saved = await p.calls("flow.gateway.save");
      expect(saved[0]?.input.name, "name").toBe("Linear");
      expect(saved[0]?.input.auth.kind, "bearer by default").toBe("bearer");
      expect(saved[0]?.input.secret, "the secret, sent").toBe("lin_s3cret_value");
      expect(await p.exists("#gateway-secret"), "the form closed").toBe(false);
      const seen = await p.evaluate(
        "document.documentElement.outerHTML.includes('lin_s3cret_value') || [...document.querySelectorAll('input')].some((i) => i.value.includes('lin_s3cret_value'))",
      );
      expect(seen, "the secret rendered back").toBe(false);
      // Changing one leaves its secret alone unless a new one is typed.
      await p.click("[data-testid=gateway-row]:nth-child(1) [data-testid=edit-gateway]");
      await p.waitFor("document.querySelector('#gateway-secret')");
      expect(await p.evaluate("document.querySelector('#gateway-secret').value"), "empty").toBe("");
      await p.click("[data-testid=save-gateway]");
      await sleep(900);
      const again = await p.calls("flow.gateway.save");
      expect(again[1]?.input.name, "GitHub").toBe("GitHub");
      // By its id, so a new name renames it; a new gateway goes without one.
      expect(again[1]?.input.gatewayId, "the gateway's id").toBe("fgw_github");
      expect("gatewayId" in (again[0]?.input ?? {}), "no id for a new one").toBe(false);
      expect("secret" in (again[1]?.input ?? {}), "no secret sent").toBe(false);
      // Removing one names it as the server keys gateways: by name.
      await p.click("[data-testid=gateway-row]:nth-child(1) [data-testid=remove-gateway]");
      await p.waitFor("document.querySelector('[data-testid=confirm-remove-gateway]')");
      await p.click("[data-testid=confirm-remove-gateway]");
      await sleep(700);
      const removed = await p.calls("flow.gateway.delete");
      expect(JSON.stringify(removed[0]?.input), "by name").toBe(
        JSON.stringify({ orgId: "org_personal", name: "GitHub" }),
      );
    },
  },
  {
    name: "flow chat: sending shows the run's steps, then what it did and its reply, folded into one line",
    async run(p) {
      await p.open("/flow/org_personal/chat?chat=fchat_launch&end=1");
      await p.waitFor("document.querySelector('[data-testid=chat-input]')");
      expect(
        await p.text("[data-testid=chat-page]"),
        "no agent in a chat with a model",
      ).not.toContain("Builder");
      expect(await p.text("[data-testid=chat-model-label]"), "the reply's model").toBe("Opus");
      const before = await p.evaluate("document.querySelectorAll('[data-testid=chat-did]').length");
      await p.focus("[data-testid=chat-input]");
      await p.type("Also add a legal check before Edit.");
      await p.key("Enter");
      await p.waitFor("document.querySelector('[data-testid=chat-working]')");
      const sent = await p.calls("flow.chat.send");
      expect(sent[0]?.input.chatId, "this chat").toBe("fchat_launch");
      expect(sent[0]?.input.text, "the message").toBe("Also add a legal check before Edit.");
      expect(sent[0]?.input.model, "the chat's model is unchanged, so not sent").toBe(undefined);
      expect(
        await p.evaluate("document.querySelector('[data-testid=chat-send]').disabled"),
        "sending waits",
      ).toBe(true);
      // The run's events are read every 2 seconds: its steps show in plain words.
      await p.waitFor(
        "[...document.querySelectorAll('[data-testid=chat-step]')].some((e) => e.textContent === 'Reading a workflow')",
        5000,
      );
      expect(await p.text("[data-testid=chat-working]"), "thinking").toContain("Thinking…");
      // The fixture's run answers a moment later; the chat is re-read every 3 seconds meanwhile.
      await p.waitFor("!document.querySelector('[data-testid=chat-working]')", 8000);
      const after = await p.evaluate("document.querySelectorAll('[data-testid=chat-did]').length");
      expect(after, "a did row arrived").toBe(before + 1);
      expect(
        await p.evaluate(
          "[...document.querySelectorAll('[data-testid=chat-reply]')].at(-1)?.textContent",
        ),
        "the reply, as Markdown",
      ).toContain("Launch content now has a Legal check before Edit");
      expect(
        await p.evaluate(
          "[...document.querySelectorAll('[data-testid=chat-reply]')].at(-1)?.querySelector('strong')?.textContent",
        ),
        "bold rendered",
      ).toBe("Legal");
      await p.waitFor(
        "[...document.querySelectorAll('[data-testid=chat-steps-summary]')].at(-1)?.textContent === 'Did 2 things'",
        5000,
      );
      await p.evaluate(
        "[...document.querySelectorAll('[data-testid=chat-steps-summary]')].at(-1).click()",
      );
      await p.waitFor(
        "[...document.querySelectorAll('[data-testid=chat-steps]')].at(-1)?.textContent",
      );
      expect(
        await p.evaluate(
          "[...document.querySelectorAll('[data-testid=chat-steps]')].at(-1)?.textContent",
        ),
        "the steps",
      ).toContain("Changing a workflow");
    },
  },
  {
    name: "flow chat: a model picked goes with the next message, and a new chat starts with it",
    async run(p) {
      await p.open("/flow/org_personal/chat?chat=fchat_plain&end=1");
      await p.waitFor("document.querySelector('[data-testid=chat-model]')");
      expect(await p.text("[data-testid=chat-model]"), "the chat's model").toBe("Opus");
      expect(await p.text("[data-testid=chat-effort]"), "the chat's effort").toBe("High");
      // A plain conversation: a Markdown reply (a table, a list) and no side pane.
      expect(await p.exists("[data-testid=chat-reply] table"), "a table").toBe(true);
      expect(await p.exists("[data-testid=chat-reply] ol"), "a list").toBe(true);
      expect(await p.exists("[data-testid=chat-made]"), "no side pane").toBe(false);
      await p.focus("[data-testid=chat-model]");
      await p.key("Enter");
      await p.waitFor("document.querySelector('[data-testid=chat-model-option]')");
      await p.evaluate(
        "[...document.querySelectorAll('[data-testid=chat-model-option]')].find((o) => o.textContent === 'Sonnet').focus()",
      );
      await p.key("Enter");
      await p.waitFor(
        "document.querySelector('[data-testid=chat-model]').textContent === 'Sonnet'",
      );
      await p.focus("[data-testid=chat-input]");
      await p.type("Shorter, please.");
      await p.key("Enter");
      await p.waitFor("document.querySelector('[data-testid=chat-working]')");
      const sent = await p.calls("flow.chat.send");
      expect(sent[0]?.input.model, "the new model").toBe("sonnet");
      expect(sent[0]?.input.effort, "the effort is unchanged").toBe(undefined);
      // A new chat starts with the last choice.
      await p.evaluate("location.hash = '#/flow/org_personal/chat'");
      await p.waitFor("document.querySelector('[data-testid=chat-empty]')");
      expect(await p.text("[data-testid=chat-model]"), "remembered").toBe("Sonnet");
      await p.evaluate("document.querySelectorAll('[data-testid=chat-example]')[0].click()");
      expect(
        await p.evaluate("document.querySelector('[data-testid=chat-input]').value"),
        "an example fills the box",
      ).toContain("search across notes");
      await p.click("[data-testid=chat-send]");
      await p.waitFor("document.querySelector('[data-testid=chat-person]')", 4000);
      const made = await p.calls("flow.chat.create");
      expect(made[0]?.input.model, "the last model").toBe("sonnet");
      expect(made[0]?.input.effort, "and effort").toBe("high");
    },
  },
  {
    name: "flow chat: the side pane lists what the chat made, and an item opens",
    async run(p) {
      await p.open("/flow/org_personal/chat?chat=fchat_notes&end=1");
      await p.waitFor("document.querySelector('[data-testid=made-item]')");
      expect(await p.text("[data-testid=made-item]"), "key and title").toContain(
        "API-13Index note titles and bodies",
      );
      await p.click("[data-testid=made-item]");
      await p.waitFor("location.hash.includes('item=fitm_chat_index')");
      expect(await p.path(), "the item").toContain("/flow/org_personal/p/fprj_api");
    },
  },
  {
    name: "flow plugins: asking starts a chat and goes to it",
    async run(p) {
      await p.open("/flow/org_personal/plugins");
      await p.waitFor("document.querySelector('[data-testid=plugin-ask-input]')");
      await p.focus("[data-testid=plugin-ask-input]");
      await p.type("Post to Slack when an item ships.");
      await p.click("[data-testid=plugin-ask-send]");
      await p.waitFor("document.querySelector('[data-testid=chat-page]')", 4000);
      const made = await p.calls("flow.chat.create");
      expect(made[0]?.input.agentId, "no agent").toBe(undefined);
      expect(made[0]?.input.text, "the words").toBe("Post to Slack when an item ships.");
      expect(await p.path(), "the new chat").toContain("chat=fchat_new");
      await p.waitFor("document.querySelector('[data-testid=chat-person]')");
      expect(await p.text("[data-testid=chat-person]"), "the message").toBe(
        "Post to Slack when an item ships.",
      );
    },
  },
  {
    name: "runs: Open run on a summary opens the run over the page; a step shows its input and result",
    async run(p) {
      await p.open(`${FLOW_BOARD}?item=fitm_rate`);
      await p.waitFor("document.querySelector('[data-testid=open-run][href*=frun_fitm_rate]')");
      await p.click("[data-testid=open-run][href*=frun_fitm_rate]");
      await p.waitFor("document.querySelector('[data-testid=run-step]')");
      expect(await p.path(), "the run in the URL").toContain("run=frun_fitm_rate");
      expect(await p.text("[data-testid=run-status]"), "finished").toBe("Finished");
      expect(await p.exists("[data-testid=item-panel]"), "the page stays behind").toBeTruthy();
      // The first Bash call: the failing tests.
      await p.evaluate(
        "[...document.querySelectorAll('[data-testid=run-step]')].find((s) => s.textContent.includes('Bash')).click()",
      );
      await sleep(200);
      expect(await p.text("[data-testid=step-input]"), "its command").toBe("go test ./api/...");
      expect(await p.text("[data-testid=step-result]"), "its result").toContain("--- FAIL");
      await p.click("[data-testid=close-run]");
      await sleep(300);
      expect(await p.exists("[data-testid=run-modal]"), "closed").toBeFalsy();
      expect(await p.path(), "the run left the URL").not.toContain("run=");
      expect(await p.path(), "the item still open").toContain("item=fitm_rate");
      // Escape closes it too.
      await p.click("[data-testid=open-run][href*=frun_fitm_rate]");
      await p.waitFor("document.querySelector('[data-testid=run-modal]')");
      await p.key("Escape");
      await sleep(300);
      expect(await p.exists("[data-testid=run-modal]"), "Escape closed it").toBeFalsy();
    },
  },
  {
    name: "runs: a run in flight reads only what is new, every 3 seconds",
    async run(p) {
      await p.open("/flow/org_personal/p/fprj_api?run=frun_fitm_webhooks&end=1");
      await p.waitFor("document.querySelector('[data-testid=run-step]')");
      expect(await p.text("[data-testid=run-status]"), "running").toBe("Running");
      const first = (await p.reads("flow.run.events")).length;
      await sleep(3500);
      const reads = await p.reads("flow.run.events");
      expect(reads.length > first, "read again").toBe(true);
      expect(typeof reads.at(-1)?.input.after, "with after").toBe("number");
      // The list keeps to the newest step.
      const atEnd = await p.evaluate(
        "(() => { const l = document.querySelector('[data-testid=step-list]'); return l.scrollHeight - l.scrollTop - l.clientHeight < 30; })()",
      );
      expect(atEnd, "scrolled to the newest").toBe(true);
    },
  },
  {
    name: "runs: Team's Recent work opens a run; Inbox's Done lists what you finished",
    async run(p) {
      await p.open("/flow/org_personal/team?agent=fagt_backend");
      await p.waitFor("document.querySelector('[data-testid=agent-run]')");
      await p.evaluate(
        "[...document.querySelectorAll('[data-testid=agent-run]')].find((r) => r.textContent.includes('Postgres')).click()",
      );
      await p.waitFor("document.querySelector('[data-testid=run-error]')");
      expect(await p.text("[data-testid=run-status]"), "failed").toBe("Failed");
      expect(await p.text("[data-testid=run-error]"), "its error").toContain("ENOSPC");
      await p.open("/flow/org_personal/inbox?tab=done");
      await p.waitFor("document.querySelector('[data-testid=inbox-done-row]')");
      expect(
        await p.evaluate("document.querySelectorAll('[data-testid=inbox-done-row]').length"),
        "two done",
      ).toBe(2);
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
      expect(await p.text("[data-testid=members]"), "a real name").toContain("Mia Chen");
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
  // Auto (.kim/mockups/auto-schedules.html; flow-auto-fixtures.ts).
  {
    name: "flow auto: New makes a weekly schedule in the first project, in this Mac's zone",
    async run(p) {
      await p.open("/flow/org_personal/auto");
      await p.waitFor("document.querySelector('[data-testid=new-schedule]')");
      await p.click("[data-testid=new-schedule]");
      await p.waitFor("document.querySelector('#schedule-name')");
      await p.focus("#schedule-name");
      await p.type("Weekly digest");
      await p.focus("#schedule-title");
      await p.type("Write the weekly digest");
      await p.click("[data-testid=every-week]");
      await p.waitFor("document.querySelector('[data-testid=schedule-day]')");
      await p.click("[data-testid=save-schedule]");
      await sleep(900);
      const saved = await p.calls("flow.schedule.save");
      expect(saved.length, "sent once").toBe(1);
      const input = saved[0]?.input ?? {};
      expect(input.scheduleId, "a new one").toBe(undefined);
      expect(input.projectId, "the first project").toBe("fprj_api");
      expect(
        `${input.every} ${input.onDay} ${input.atHour}:${input.atMinute}`,
        "Mondays 09:00",
      ).toBe("week 1 9:0");
      expect(input.title, "the item's title").toBe("Write the weekly digest");
      expect(input.timeZone, "this Mac's zone").toBe(
        await p.evaluate("Intl.DateTimeFormat().resolvedOptions().timeZone"),
      );
      expect(await p.exists("#schedule-name"), "the form closed").toBe(false);
    },
  },
  {
    name: "flow auto: a row's switch turns it off, and its menu runs it now and removes it",
    async run(p) {
      await p.open("/flow/org_personal/auto");
      await p.waitFor("document.querySelector('[data-testid=schedule-switch]')");
      await p.click("[data-testid=schedule-switch]");
      await sleep(700);
      const set = await p.calls("flow.schedule.save");
      expect(set[0]?.input.scheduleId, "the first row").toBe("fsch_deps");
      expect(set[0]?.input.enabled, "off").toBe(false);
      // Radix opens a menu on pointerdown, not click.
      const openMenu = () =>
        p.evaluate(
          "document.querySelector('[data-testid=schedule-menu]').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }))",
        );
      await openMenu();
      await p.waitFor("document.querySelector('[data-testid=run-schedule]')");
      await p.click("[data-testid=run-schedule]");
      await sleep(700);
      const ran = await p.calls("flow.schedule.runNow");
      expect(ran[0]?.input.scheduleId, "ran").toBe("fsch_deps");
      await openMenu();
      await p.waitFor("document.querySelector('[data-testid=remove-schedule]')");
      await p.click("[data-testid=remove-schedule]");
      await p.waitFor("document.querySelector('[data-testid=confirm-remove-schedule]')");
      await p.click("[data-testid=confirm-remove-schedule]");
      await sleep(700);
      const removed = await p.calls("flow.schedule.delete");
      expect(removed[0]?.input.scheduleId, "removed").toBe("fsch_deps");
    },
  },
  {
    name: "flow auto: Last links to the item a schedule made; Triggers points at Plugins",
    async run(p) {
      await p.open("/flow/org_personal/auto");
      await p.waitFor("document.querySelector('[data-testid=schedule-last] a')");
      await p.evaluate(
        "[...document.querySelectorAll('[data-testid=schedule-last] a')].find((a) => a.textContent.includes('API-5')).click()",
      );
      await p.waitFor("document.querySelector('[data-testid=item-panel]')");
      expect(await p.path(), "the item on its board").toBe(
        "/flow/org_personal/p/fprj_api?item=fitm_usage",
      );
      await p.open("/flow/org_personal/auto?tab=triggers");
      await p.waitFor("document.querySelector('[data-testid=triggers-note] a')");
      await p.click("[data-testid=triggers-note] a");
      await p.waitFor("document.querySelector('[data-testid=plugins-page]')");
      expect(await p.path(), "Plugins").toBe("/flow/org_personal/plugins");
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

// The cache belongs to one sign-in (review of #184): another login or device while signed in
// resets it, as signing in or out does, and the signed-out error never leaves an empty window.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SignedOutWait } from "../src/mainview/components/app-error.tsx";
import { openedDiffKey } from "../src/mainview/components/review-parts.tsx";
import {
  accountKey,
  accountLogin,
  claimAccountLocal,
  clearAccountData,
  clearAccountLocal,
  gateAccount,
  gateLoaded,
  initialGate,
  type RoutesGate,
  shownFor,
} from "../src/mainview/lib/account.ts";
import { openTerminal, terminalFor } from "../src/mainview/lib/open-terminals.ts";
import type { TerminalRun } from "../src/mainview/lib/terminal.ts";
import { DRAG } from "../src/mainview/lib/title-bar.ts";
import {
  getViewState,
  togglePin,
  updateViewState,
  VIEW_STATE_KEY,
} from "../src/mainview/lib/view-state.ts";

vi.mock("../src/mainview/bridge.ts", () => import("./bridge-stub.ts"));

describe("accountKey", () => {
  it("changes with the login and the device, not only with signed in", () => {
    const owner = accountKey({ signedIn: true, login: "owner", deviceId: "dev_m5" });
    expect(owner).toBe("in:owner:dev_m5");
    expect(accountKey({ signedIn: true, login: "other", deviceId: "dev_m5" })).not.toBe(owner);
    expect(accountKey({ signedIn: true, login: "owner", deviceId: "dev_m1" })).not.toBe(owner);
    expect(accountKey({ signedIn: false, login: null, deviceId: null })).toBe("out");
    expect(accountKey(null)).toBeNull();
  });
});

describe("clearAccountData", () => {
  it("leaves nothing the previous account read, only the app's session and update status", () => {
    const client = new QueryClient();
    client.setQueryData(["me"], { userId: "u_owner" });
    client.setQueryData(["inbox"], { gates: [{ id: "g_owner" }] });
    client.setQueryData(["workItem", "wi_owner"], { item: { title: "owner's item" } });
    client.setQueryData(["session"], { signedIn: true, login: "other" });
    client.setQueryData(["update"], { required: false });
    clearAccountData(client);
    expect(client.getQueryData(["me"])).toBeUndefined();
    expect(client.getQueryData(["inbox"])).toBeUndefined();
    expect(client.getQueryData(["workItem", "wi_owner"])).toBeUndefined();
    expect(client.getQueryData(["session"])).toEqual({ signedIn: true, login: "other" });
    expect(client.getQueryData(["update"])).toEqual({ required: false });
  });
});

/** A Storage in memory, with the keys a window keeps. */
function memoryStorage(entries: Record<string, string>) {
  const m = new Map(Object.entries(entries));
  return {
    get length() {
      return m.size;
    },
    key: (i: number) => [...m.keys()][i] ?? null,
    removeItem: (k: string) => void m.delete(k),
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    keys: () => [...m.keys()].sort(),
  };
}

/**
 * useSignedInRoutes (routes/root.tsx), step by step as React runs it: each render returns
 * `shownFor(gate, account)` for the account being rendered, then the effect applies the account
 * (`gateAccount`), resets what the previous account left, and the reload settles (`gateLoaded`).
 * Every frame's answer is recorded, with what the cache held while it rendered.
 */
function drive(client: QueryClient, accounts: (string | null)[]) {
  let gate: RoutesGate = initialGate(accounts[0] ?? null);
  const frames: { account: string | null; shown: number | null; me: unknown }[] = [];
  const pending: number[] = [];
  const render = (account: string | null) =>
    frames.push({ account, shown: shownFor(gate, account), me: client.getQueryData(["me"]) });
  for (const account of accounts) {
    render(account); // the render with the new account, before its effect
    const { gate: next, reset } = gateAccount(gate, account);
    gate = next;
    if (reset !== null) {
      clearAccountData(client);
      pending.push(reset);
    }
    render(account); // the render after the effect's state change
  }
  const settle = (account: string | null) => {
    for (const r of pending.splice(0)) gate = gateLoaded(gate, r);
    // The routes loaded for the new account: it reads its own data.
    client.setQueryData(["me"], { login: account });
    render(account);
  };
  return { frames, settle, gate: () => gate };
}

describe("switching accounts while signed in", () => {
  const A = "in:owner:dev_m5";
  const B = "in:other:dev_m5";

  it("never renders a frame of the previous account's routes, and its data is gone", () => {
    const client = new QueryClient();
    client.setQueryData(["me"], { login: "owner" });
    client.setQueryData(["workItem", "wi_owner"], { item: { title: "owner's item" } });
    const run = drive(client, [A, B]);
    run.settle(B);
    // A's routes show only while A is the account rendered.
    expect(
      run.frames.filter((f) => f.shown !== null && f.account !== A).map((f) => f.shown),
    ).toEqual([1]);
    // The first frame with B, before the effect ran, shows a skeleton, not A's routes.
    expect(run.frames.find((f) => f.account === B)).toMatchObject({ shown: null });
    // Shown for B only under a new key, after the reload, and with B's data only.
    const shownB = run.frames.filter((f) => f.account === B && f.shown !== null);
    expect(shownB).toEqual([{ account: B, shown: 1, me: { login: B } }]);
    expect(client.getQueryData(["workItem", "wi_owner"])).toBeUndefined();
  });

  it("a reload that settles after yet another switch shows nothing for the stale one", () => {
    let gate = initialGate(A);
    const toB = gateAccount(gate, B);
    gate = toB.gate;
    const toC = gateAccount(gate, "in:third:dev_m5");
    gate = toC.gate;
    // B's reload settles late: not shown, for anyone.
    gate = gateLoaded(gate, toB.reset ?? -1);
    expect(shownFor(gate, B)).toBeNull();
    expect(shownFor(gate, "in:third:dev_m5")).toBeNull();
    gate = gateLoaded(gate, toC.reset ?? -1);
    expect(shownFor(gate, "in:third:dev_m5")).toBe(2);
  });

  it("signing out shows no routes, and signing in again reloads them under a new key", () => {
    let gate = initialGate(A);
    gate = gateAccount(gate, "out").gate;
    expect(shownFor(gate, "out")).toBeNull();
    const back = gateAccount(gate, A);
    expect(back.reset).toBe(2);
    expect(shownFor(gateLoaded(back.gate, 2), A)).toBe(2);
  });

  it("forgets this Mac's state for the previous account: tabs, pins, org, drafts, terminals", () => {
    updateViewState((s) => ({ ...togglePin(s, "wi_owner"), orgId: "org_owner" }));
    openTerminal("wi_owner", {} as TerminalRun);
    const storage = memoryStorage({
      [VIEW_STATE_KEY]: JSON.stringify({ pins: ["wi_owner"] }),
      "sf-canvas-wi_owner": "{}",
      "sf-mentions-ed_1": "@owner",
      "sf-panel-width": "420",
      "sf-mockups": "on",
    });
    const session = memoryStorage({
      [openedDiffKey("u_owner", "wi_owner", "abc")]: "1",
      "sf-other": "kept",
    });
    clearAccountLocal(storage, session);
    expect(storage.keys()).toEqual(["sf-mockups", "sf-panel-width"]);
    expect(session.keys()).toEqual(["sf-other"]);
    expect(getViewState()).toMatchObject({ pins: [], orgId: undefined });
    expect(getViewState().tabs.map((t) => t.path)).toEqual(["/"]);
    expect(terminalFor("wi_owner")).toBeNull();
  });
});

describe("a signed-out refusal on the error screen", () => {
  const render = (late: boolean) =>
    renderToString(
      <QueryClientProvider client={new QueryClient()}>
        <SignedOutWait late={late} busy={false} retry={() => undefined} />
      </QueryClientProvider>,
    );

  it("shows the window's loading shell first (it drags), never nothing", () => {
    const html = render(false);
    expect(html).toContain('data-testid="window-skeleton"');
    expect(html).toContain('data-testid="toolbar-skeleton"');
  });

  it("then a line with Retry, over the drag strip", () => {
    const html = render(true);
    expect(html).toContain('data-testid="signed-out-wait"');
    expect(html).toContain("Retry");
    expect(html).toContain(`fixed inset-x-0 top-0 h-11 ${DRAG}`);
  });
});

describe("this Mac's account state belongs to one login", () => {
  const kept = () =>
    memoryStorage({
      [VIEW_STATE_KEY]: JSON.stringify({ pins: ["wi_a"] }),
      "sf-canvas-wi_a": "{}",
    });

  it("signing out and back in as the same login keeps tabs, pins and canvases", () => {
    const storage = kept();
    const session = memoryStorage({ [openedDiffKey("u_a", "wi_a", "abc")]: "1" });
    expect(accountLogin("in:alice:dev_1")).toBe("alice");
    expect(accountLogin("out")).toBeNull();
    expect(claimAccountLocal("alice", storage, session)).toBe(false);
    updateViewState((s) => togglePin(s, "wi_a"));
    // Out, then in again: a new device id (signing out revokes the old one), the same login.
    expect(claimAccountLocal(accountLogin("in:alice:dev_2") ?? "", storage, session)).toBe(false);
    expect(storage.keys()).toEqual(["sf-account-owner", "sf-canvas-wi_a", VIEW_STATE_KEY].sort());
    expect(session.keys()).toHaveLength(1);
    expect(getViewState().pins).toContain("wi_a");
  });

  it("another login forgets them, and the diffs the first opened", () => {
    const storage = kept();
    const session = memoryStorage({ [openedDiffKey("u_a", "wi_a", "abc")]: "1" });
    claimAccountLocal("alice", storage, session);
    updateViewState((s) => togglePin(s, "wi_a"));
    expect(claimAccountLocal("bob", storage, session)).toBe(true);
    expect(storage.keys()).toEqual(["sf-account-owner"]);
    expect(session.keys()).toEqual([]);
    expect(getViewState().pins).toEqual([]);
  });

  it("an approval reads only its own account's opened-diff flag", () => {
    expect(openedDiffKey("u_a", "wi_1", "abc")).not.toBe(openedDiffKey("u_b", "wi_1", "abc"));
  });
});

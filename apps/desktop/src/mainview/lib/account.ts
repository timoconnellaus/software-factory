// Which account the window is showing (review of #184): the cache, this Mac's view state and the
// routes belong to one sign-in, so they are reset whenever it changes, not only when "signed in"
// flips. The main process's `auth.finish` doesn't require being signed out first, so a second
// sign-in (another login, or this Mac approved again as another device) arrives while signed in.
//
// The routes' gate (`useSignedInRoutes` in routes/root.tsx) is a state machine here, so the tests
// drive it step by step as the hook does. What it shows is decided in render, against the account
// being rendered: the frame after a switch never shows the previous account's routes, even before
// the hook's effect has run.
import type { QueryClient } from "@tanstack/react-query";
import type { Session } from "../../shared/rpc.ts";
import { closeAllTerminals } from "./open-terminals.ts";
import { resetViewState, VIEW_STATE_KEY } from "./view-state.ts";

/** The signed-in account as a key ("in:<login>:<deviceId>"), "out", or null before the first answer. */
export function accountKey(
  session: Pick<Session, "signedIn" | "login" | "deviceId"> | null | undefined,
): string | null {
  if (!session) return null;
  return session.signedIn ? `in:${session.login ?? ""}:${session.deviceId ?? ""}` : "out";
}

/** Empties everything the previous account read. The session and update status are the app's. */
export function clearAccountData(client: QueryClient) {
  client.removeQueries({
    predicate: (q) => q.queryKey[0] !== "session" && q.queryKey[0] !== "update",
  });
}

/** localStorage keys that hold one account's view of its work: its items' ids and drafts. */
const ACCOUNT_KEYS = (k: string) =>
  k === VIEW_STATE_KEY || k.startsWith("sf-canvas-") || k.startsWith("sf-mentions-");

/** sessionStorage keys of one account: which full diffs it opened (components/review-parts.tsx). */
export const OPENED_DIFF_PREFIX = "sf:opened-diff:";

/** localStorage: the login this Mac's kept account state belongs to. Never cleared with it. */
export const OWNER_KEY = "sf-account-owner";

type KeyedStorage = Pick<Storage, "length" | "key" | "removeItem">;

/** The login of a signed-in account key ("in:<login>:<deviceId>"), else null. */
export function accountLogin(account: string | null): string | null {
  if (!account?.startsWith("in:")) return null;
  return account.slice(3, account.lastIndexOf(":"));
}

function removeKeys(store: KeyedStorage | undefined, which: (k: string) => boolean) {
  try {
    // Read inside the try: a blocked storage throws on access.
    if (!store) return;
    const keys: string[] = [];
    for (let i = 0; i < store.length; i++) {
      const k = store.key(i);
      if (k !== null && which(k)) keys.push(k);
    }
    for (const k of keys) store.removeItem(k);
  } catch {
    // Storage blocked: nothing was kept.
  }
}

/**
 * Forgets what this Mac kept for the previous account: the view state (open tabs, pinned items,
 * the chosen org), each item's planning canvas layout and mention drafts, which full diffs it
 * opened, and the open terminals. What isn't the account's (the panel width, developer switches)
 * stays.
 */
export function clearAccountLocal(storage?: KeyedStorage, session?: KeyedStorage) {
  let local = storage;
  let tab = session;
  try {
    local ??= globalThis.localStorage;
    tab ??= globalThis.sessionStorage;
  } catch {
    // Storage blocked.
  }
  removeKeys(local, ACCOUNT_KEYS);
  removeKeys(tab, (k) => k.startsWith(OPENED_DIFF_PREFIX));
  resetViewState();
  closeAllTerminals();
}

/**
 * Signed in as `login`: this Mac's kept account state is that login's from now on. If it was
 * another login's, it is forgotten first (`clearAccountLocal`); signing out and back in as the same
 * login keeps the tabs, pins and canvases. State kept before the owner was recorded is adopted.
 * Returns whether it forgot anything.
 */
let ownerInMemory: string | null = null;

export function claimAccountLocal(
  login: string,
  storage?: Pick<Storage, "getItem" | "setItem"> & KeyedStorage,
  session?: KeyedStorage,
): boolean {
  let owner: string | null = null;
  let local = storage;
  try {
    local ??= globalThis.localStorage;
    owner = local?.getItem(OWNER_KEY) ?? null;
  } catch {
    // Storage blocked: nothing was kept there, but the memory's view state may be another login's.
  }
  owner ??= ownerInMemory;
  ownerInMemory = login;
  const other = owner !== null && owner !== login;
  if (other) clearAccountLocal(local, session);
  try {
    local?.setItem(OWNER_KEY, login);
  } catch {
    // ignore
  }
  return other;
}

/** The routes' gate: the account last seen, and which load of the routes shows, for whom. */
export interface RoutesGate {
  known: string | null;
  generation: number;
  shown: { generation: number; account: string } | null;
}

const signedIn = (account: string | null): account is string =>
  account !== null && account !== "out";

/** Signed in when first rendered: shown at once (the router is loading with that session). */
export function initialGate(account: string | null): RoutesGate {
  return {
    known: account,
    generation: 0,
    shown: signedIn(account) ? { generation: 0, account } : null,
  };
}

/**
 * The main process answered with `account`. `reset` is set when it is another account than the
 * one shown: the caller empties the cache and this Mac's account state, loads the routes again,
 * then calls `gateLoaded` with it.
 */
export function gateAccount(
  g: RoutesGate,
  account: string | null,
): { gate: RoutesGate; reset: number | null } {
  if (account === null || g.known === account) return { gate: g, reset: null };
  // The first answer: the router is loading with that session already (`_app` asks it).
  if (g.known === null) return { gate: initialGate(account), reset: null };
  const generation = g.generation + 1;
  return { gate: { known: account, generation, shown: null }, reset: generation };
}

/** The routes loaded again for the reset `generation`: shown if nothing has changed since. */
export function gateLoaded(g: RoutesGate, generation: number): RoutesGate {
  if (g.generation !== generation || !signedIn(g.known)) return g;
  return { ...g, shown: { generation, account: g.known } };
}

/** The routes' key while they are shown for `account`, else null (a skeleton). */
export function shownFor(g: RoutesGate, account: string | null): number | null {
  return g.shown && g.shown.account === account ? g.shown.generation : null;
}

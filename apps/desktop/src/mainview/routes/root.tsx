// The root: signed out shows sign-in; signed in shows the `_app` layout. `sf://` links arrive from the
// main process as paths and are routed here, with the hash history (views:// has no server).
// Signed out is a state, never an error: the routes still load while the sign-in screen shows (and
// refuse as signed out), so on signing in the routes are loaded again before they are shown, under
// fresh error boundaries (`generation`). Any error no page handles lands on AppError.
import { Button } from "@software-factory/ui/components/button";
import { Card } from "@software-factory/ui/components/card";
import { Toaster } from "@software-factory/ui/components/sonner";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, Outlet, useRouter } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import type { Session } from "../../shared/rpc.ts";
import { bun, onInbox, onNavigate } from "../bridge.ts";
import { AppError } from "../components/app-error.tsx";
import { KeyNotices } from "../components/key-notices.tsx";
import { UpdateRequired } from "../components/update-required.tsx";
import { Updating } from "../components/updating.tsx";
import { WindowSkeleton } from "../components/window-skeleton.tsx";
import {
  accountKey,
  accountLogin,
  claimAccountLocal,
  clearAccountData,
  gateAccount,
  gateLoaded,
  initialGate,
  shownFor,
} from "../lib/account.ts";
import { useDesktopSession, useUpdateStatus } from "../lib/desktop-session.ts";
import { closeAllTerminals } from "../lib/open-terminals.ts";
import { DRAG } from "../lib/title-bar.ts";

export const rootRoute = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  component: Root,
  errorComponent: AppError,
});

/** An `sf://` link's path as a route in the app (ADR 0382's trampoline sends these). */
export function routeForLink(path: string): string {
  const [p = "/", search = ""] = path.split("?");
  const clean = `/${p.replace(/^\/+|\/+$/g, "")}`;
  const q = search ? `?${search}` : "";
  if (clean === "/inbox" || clean === "/") return `/${q}`;
  if (/^\/work\/[A-Za-z0-9_-]{1,80}(\/review)?$/.test(clean)) return clean;
  if (clean === "/attach") return `/attach${q}`;
  if (clean === "/setup" || clean === "/new" || clean === "/work" || clean === "/settings")
    return clean;
  return "/";
}

function Root() {
  const router = useRouter();
  const client = useQueryClient();
  const session = useDesktopSession();
  const update = useUpdateStatus();
  useEffect(
    () =>
      onNavigate((path) => {
        void client.invalidateQueries();
        router.history.push(routeForLink(path));
      }),
    [router, client],
  );
  // The main process's inbox count changes on a live push or a poll: refresh what shows gates,
  // and the Work lists and board, which the same events move (a gate opened, an item shaped).
  useEffect(
    () =>
      onInbox(() => {
        void client.invalidateQueries({ queryKey: ["inbox"] });
        void client.invalidateQueries({ queryKey: ["work"] });
      }),
    [client],
  );
  // Signing in or out, or as another account, changes everything the cache holds.
  const shown = useSignedInRoutes(accountKey(session));
  // The main process hasn't answered yet: the window's shell, as index.html drew it.
  if (!session) return <WindowSkeleton />;
  // Restart to update, from the click until the app restarts (or a refusal): the whole window.
  if (update?.applying)
    return (
      <Updating
        applying={update.applying}
        back={async () =>
          client.setQueryData(["update"], await bun.updateAction({ action: "back" }))
        }
        quit={async () => {
          await bun.updateAction({ action: "quit" });
        }}
      />
    );
  // The door refused this build (ADR 0393): only updating helps, signed in or not.
  if (update?.required)
    return (
      <UpdateRequired
        status={update}
        act={async (action) => {
          client.setQueryData(["update"], await bun.updateAction({ action }));
          if (action === "retry") void client.invalidateQueries();
        }}
      />
    );
  return (
    <>
      {!session.signedIn ? (
        <SignIn session={session} />
      ) : shown !== null ? (
        <Outlet key={shown} />
      ) : (
        <WindowSkeleton />
      )}
      <Toaster position="bottom-right" closeButton />
      <KeyNotices session={session} />
    </>
  );
}

/**
 * Which signed-in session the routes are shown for (a number that changes with each sign-in), or
 * null while they load again for it. Signed in at launch: shown at once, as the router loads them.
 * Signing in or out, or a sign-in as another login or device while signed in (`account`, from
 * lib/account.ts), empties the cache and closes the open terminals, goes back to the start and
 * reloads the routes; only then are they shown, keyed afresh. This Mac's account state (tabs, pins,
 * the chosen org, canvases, drafts) is kept for the same login and forgotten for another one
 * (`claimAccountLocal`), so signing out and back in keeps it. What shows is decided in render
 * against the account rendered (`shownFor`), so not one frame shows the previous account's routes.
 */
export function useSignedInRoutes(account: string | null): number | null {
  const router = useRouter();
  const client = useQueryClient();
  const [gate, setGate] = useState(() => initialGate(account));
  const latest = useRef(gate);
  latest.current = gate;
  useEffect(() => {
    const { gate: next, reset } = gateAccount(latest.current, account);
    if (next !== latest.current) {
      latest.current = next;
      setGate(next);
    }
    // This Mac's tabs, pins and canvases are one login's: another login forgets them first.
    const login = accountLogin(account);
    if (login !== null) claimAccountLocal(login);
    if (reset === null) return;
    // The update status is the app's, not the account's: it survives (ADR 0393). The cache and
    // the open terminals go with every change, signing out included.
    clearAccountData(client);
    closeAllTerminals();
    router.history.replace("/");
    void router
      .invalidate()
      .catch(() => undefined)
      .finally(() => setGate((g) => gateLoaded(g, reset)));
  }, [account, client, router]);
  return shownFor(gate, account);
}

function SignIn({ session }: { session: Session }) {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  return (
    <main className="mx-auto grid min-h-screen max-w-md place-content-center gap-4 p-6">
      {/* The window has no title bar (spec 41): the top strip still moves it. */}
      <div aria-hidden="true" className={`fixed inset-x-0 top-0 h-11 ${DRAG}`} />
      <h1 className="font-semibold text-2xl tracking-tight">Software Factory</h1>
      <p className="text-muted-foreground text-sm">
        Sign in through your browser. You'll approve this Mac on the website, then come back here.
      </p>
      {session.error && <Card className="px-4 py-3 text-destructive text-sm">{session.error}</Card>}
      <Button
        disabled={busy}
        data-testid="sign-in"
        onClick={async () => {
          setBusy(true);
          client.setQueryData(["session"], await bun.signIn({}));
          setBusy(false);
        }}
      >
        {session.signingIn ? "Waiting for the browser…" : "Sign in"}
      </Button>
      {session.keyFingerprint && (
        <p className="text-muted-foreground text-sm" data-testid="key-fingerprint">
          This Mac's key:{" "}
          <span className="font-mono text-foreground">{session.keyFingerprint}</span>. Approve on
          the website only if it shows exactly this fingerprint, all four groups.
        </p>
      )}
    </main>
  );
}

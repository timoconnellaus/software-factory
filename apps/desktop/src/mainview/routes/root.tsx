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
import { accountKey, clearAccountData } from "../lib/account.ts";
import { useDesktopSession, useUpdateStatus } from "../lib/desktop-session.ts";
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
 * lib/account.ts), empties the cache and reloads the routes; only then are they shown, keyed
 * afresh, so nothing the previous account read, or caught while signed out, is shown.
 */
function useSignedInRoutes(account: string | null): number | null {
  const signedIn = account === null ? null : account !== "out";
  const router = useRouter();
  const client = useQueryClient();
  // Signed in when first rendered: shown at once (the router is loading with that session).
  const [shown, setShown] = useState<number | null>(signedIn ? 0 : null);
  const generation = useRef(0);
  /** The account as last known: null until the main process first answers. */
  const known = useRef<string | null>(account);
  useEffect(() => {
    if (account === null) return;
    const before = known.current;
    known.current = account;
    // The first answer: the router is loading with that session already (`_app` asks it).
    if (before === null) {
      if (signedIn) setShown(0);
      return;
    }
    if (before === account) return;
    const mine = ++generation.current;
    setShown(null);
    // The update status is the app's, not the account's: it survives (ADR 0393).
    clearAccountData(client);
    void router
      .invalidate()
      .catch(() => undefined)
      .finally(() => {
        if (signedIn && generation.current === mine) setShown(mine);
      });
  }, [account, signedIn, client, router]);
  return shown;
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

// The signed-in pages: a plain header, then the page. Everything else lives in the desktop app.
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { useEffect } from "react";
import { sessionQuery } from "#/lib/session";

export const Route = createFileRoute("/_app")({
  // The session comes from the query cache: fetched once per page load, then re-checked in the
  // background once stale (and AppLayout signs out if it has gone). Every operation still checks
  // the session itself.
  beforeLoad: async ({ context, location }) => {
    const session = await context.queryClient.ensureQueryData({
      ...sessionQuery(),
      revalidateIfStale: true,
    });
    if (!session) throw redirect({ to: "/sign-in", search: { redirect: location.href } });
    return { session };
  },
  component: AppLayout,
});

function AppLayout() {
  useSignOutWhenSessionEnds();
  return (
    <div className="min-h-dvh">
      <header className="flex h-14 items-center border-b px-4 md:px-6">
        <span className="font-medium text-sm">Software Factory</span>
      </header>
      <Outlet />
    </div>
  );
}

/** A background session check that finds no session sends the person to sign in. */
function useSignOutWhenSessionEnds() {
  const session = useQuery(sessionQuery());
  const ended = session.isSuccess && session.data === null;
  useEffect(() => {
    if (ended) {
      window.location.assign(`/sign-in?redirect=${encodeURIComponent(window.location.pathname)}`);
    }
  }, [ended]);
}

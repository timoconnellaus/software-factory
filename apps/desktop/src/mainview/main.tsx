// The desktop app's view (ADR 0380, spec 40 M2): a TanStack Router (hash history: views:// has no
// server for paths) + Query SPA on packages/ui. M2 has sign-in, the inbox, a work item summary and
// the runner; the full screens move here in M3.
import { Button } from "@software-factory/ui/components/button";
import { Card } from "@software-factory/ui/components/card";
import { StatusDot } from "@software-factory/ui/components/status-dot";
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createHashHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Outlet,
  RouterProvider,
  useNavigate,
} from "@tanstack/react-router";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { CallResult, RunnerState, Session } from "../shared/rpc.ts";
import { bun, onInbox, onNavigate, onRunner, onSession } from "./bridge.ts";
import "./styles.css";

const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });

/** An operation's result, or a thrown error the query shows. */
async function op<T>(name: string, input: unknown): Promise<T> {
  const res: CallResult = await bun.call({ op: name, input });
  if (!res.ok) throw new Error(res.error);
  return res.result as T;
}

function useSession() {
  const client = useQueryClient();
  const q = useQuery({ queryKey: ["session"], queryFn: () => bun.session({}) });
  useEffect(() => onSession((s) => client.setQueryData(["session"], s)), [client]);
  return q.data;
}

function Shell() {
  const navigate = useNavigate();
  const client = useQueryClient();
  const session = useSession();
  const [count, setCount] = useState(0);
  useEffect(() => onInbox(setCount), []);
  useEffect(
    () =>
      onNavigate((path) => {
        const [p, search = ""] = path.split("?");
        if (p?.startsWith("/work/")) {
          void navigate({ to: "/work/$id", params: { id: p.split("/")[2] ?? "" } });
        } else if (p === "/setup") {
          void navigate({ to: "/settings" });
        } else {
          void navigate({ to: "/" });
        }
        void search;
        void client.invalidateQueries();
      }),
    [navigate, client],
  );
  if (!session) return null;
  if (!session.signedIn) return <SignIn session={session} />;
  return (
    <div className="flex min-h-screen bg-background text-foreground">
      <nav className="flex w-52 flex-col gap-1 border-r bg-sidebar p-3 text-sm">
        <div className="px-2 pb-2 font-semibold">Software Factory</div>
        <Link
          to="/"
          className="flex justify-between rounded px-2 py-1 [&.active]:bg-sidebar-accent"
        >
          Inbox {count > 0 && <span className="text-muted-foreground">{count}</span>}
        </Link>
        <Link to="/settings" className="rounded px-2 py-1 [&.active]:bg-sidebar-accent">
          Runner &amp; settings
        </Link>
        <div className="mt-auto px-2 text-muted-foreground text-xs">
          {session.login ? `@${session.login}` : "signed in"}
        </div>
      </nav>
      <main className="flex-1 p-6">
        <Outlet />
      </main>
    </div>
  );
}

function SignIn({ session }: { session: Session }) {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  return (
    <main className="mx-auto grid min-h-screen max-w-md place-content-center gap-4 p-6">
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
    </main>
  );
}

interface Inbox {
  gates: {
    id: string;
    kind: string;
    title: string;
    workItemId: string | null;
    createdAt: string;
  }[];
  questions: { id: string; workItemId: string; title: string; prompt: string }[];
  running: { id: string; title: string; number: number; status: string }[];
}

const gateLabel = (kind: string) =>
  kind === "spec" ? "Spec waiting" : kind === "merge" ? "Ready to merge" : "Approval needed";

function InboxPage() {
  const inbox = useQuery({
    queryKey: ["inbox"],
    queryFn: () => op<Inbox>("inbox.list", {}),
    refetchInterval: 15_000,
  });
  if (inbox.isPending) return <div className="text-muted-foreground text-sm">Loading…</div>;
  if (inbox.isError)
    return <Card className="px-4 py-3 text-destructive text-sm">{inbox.error.message}</Card>;
  const { gates, questions, running } = inbox.data;
  return (
    <div className="grid max-w-3xl gap-4">
      <h1 className="font-semibold text-xl">Waiting on you</h1>
      {gates.length + questions.length === 0 && (
        <Card className="px-4 py-3 text-muted-foreground text-sm">Nothing is waiting on you.</Card>
      )}
      {gates.map((g) => (
        <Card
          key={g.id}
          className="flex-row items-center gap-3 px-4 py-3 text-sm"
          data-testid="inbox-gate"
        >
          <StatusDot status="waiting" />
          <span className="font-medium">{gateLabel(g.kind)}</span>
          <span className="flex-1 truncate">{g.title}</span>
          {g.workItemId && (
            <Link to="/work/$id" params={{ id: g.workItemId }} className="text-xs underline">
              Open
            </Link>
          )}
        </Card>
      ))}
      {questions.map((q) => (
        <Card key={q.id} className="gap-1 px-4 py-3 text-sm">
          <div className="font-medium">Question: {q.title}</div>
          <div className="text-muted-foreground">{q.prompt}</div>
        </Card>
      ))}
      {running.length > 0 && (
        <>
          <h2 className="mt-2 font-semibold">Running</h2>
          {running.map((r) => (
            <Card key={r.id} className="flex-row items-center gap-3 px-4 py-3 text-sm">
              <StatusDot status="running" />
              <span className="text-muted-foreground">#{r.number}</span>
              <Link to="/work/$id" params={{ id: r.id }} className="flex-1 truncate">
                {r.title}
              </Link>
              <span className="text-muted-foreground text-xs">{r.status}</span>
            </Card>
          ))}
        </>
      )}
    </div>
  );
}

function WorkPage() {
  const { id } = workRoute.useParams();
  const item = useQuery({
    queryKey: ["work", id],
    queryFn: () =>
      op<{
        item: {
          number: number;
          title: string;
          status: string;
          stage: string | null;
          prUrl: string | null;
        };
      }>("workItem.get", { workItemId: id }),
  });
  if (item.isPending) return <div className="text-muted-foreground text-sm">Loading…</div>;
  if (item.isError)
    return <Card className="px-4 py-3 text-destructive text-sm">{item.error.message}</Card>;
  const w = item.data.item;
  return (
    <Card className="max-w-3xl gap-2 px-5 py-4">
      <div className="text-muted-foreground text-xs">#{w.number}</div>
      <h1 className="font-semibold text-xl">{w.title}</h1>
      <div className="text-sm">
        {w.status}
        {w.stage ? ` · ${w.stage}` : ""}
      </div>
      {w.prUrl && (
        <button
          type="button"
          className="w-fit text-sm underline"
          onClick={() => bun.openExternal({ url: w.prUrl ?? "" })}
        >
          Pull request
        </button>
      )}
      <p className="text-muted-foreground text-xs">
        The full work item, planning and review packet arrive in the next release (spec 40 M3).
      </p>
    </Card>
  );
}

const RUNNER_TEXT: Record<RunnerState["status"], string> = {
  unpaired: "This Mac isn't paired as a runner yet.",
  launchd:
    "The runner is running as a launchd service. The app can run it instead (same runner, same identity).",
  stopped: "Stopped.",
  starting: "Starting…",
  running: "Running.",
  restarting: "Restarting…",
  locked: "Another runner host is running on this Mac. The app waits for it to stop.",
  failed: "Failed.",
};

function SettingsPage() {
  const client = useQueryClient();
  const session = useSession();
  const runner = useQuery({ queryKey: ["runner"], queryFn: () => bun.runnerState({}) });
  const login = useQuery({ queryKey: ["login-item"], queryFn: () => bun.loginItem({}) });
  useEffect(() => onRunner((s) => client.setQueryData(["runner"], s)), [client]);
  const r = runner.data;
  return (
    <div className="grid max-w-2xl gap-4">
      <Card className="gap-3 px-5 py-4" data-testid="runner">
        <div className="flex items-center gap-2 font-semibold">
          <StatusDot
            status={
              r?.status === "running" ? "running" : r?.status === "failed" ? "failed" : "idle"
            }
          />
          This Mac's runner
        </div>
        <div className="text-sm">{r ? RUNNER_TEXT[r.status] : "…"}</div>
        {r?.lastLine && (
          <pre className="overflow-x-auto rounded bg-muted p-2 font-mono text-xs">{r.lastLine}</pre>
        )}
        <div className="flex gap-2">
          {r?.status === "unpaired" && (
            <Button size="sm" onClick={() => bun.runnerAction({ action: "pair" })}>
              Pair this Mac
            </Button>
          )}
          {r?.status === "launchd" && (
            <Button size="sm" onClick={() => bun.runnerAction({ action: "takeover" })}>
              Run it in the app
            </Button>
          )}
          {(r?.status === "running" || r?.status === "failed") && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => bun.runnerAction({ action: "restart" })}
            >
              Restart
            </Button>
          )}
        </div>
      </Card>
      <Card className="gap-3 px-5 py-4">
        <div className="font-semibold">This Mac</div>
        <div className="text-muted-foreground text-sm">
          {session?.keyStorage === "secure-enclave"
            ? "Decisions are signed by a key in this Mac's Secure Enclave: approving asks for Touch ID."
            : "This build has a software key (not signed for the Secure Enclave)."}
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={login.data?.enabled ?? false}
            onChange={async (e) =>
              client.setQueryData(["login-item"], await bun.loginItem({ enable: e.target.checked }))
            }
          />
          Open at login
        </label>
        <Button
          size="sm"
          variant="outline"
          className="w-fit"
          onClick={async () => client.setQueryData(["session"], await bun.signOut({}))}
        >
          Sign out
        </Button>
      </Card>
    </div>
  );
}

const root = createRootRoute({ component: Shell });
const workRoute = createRoute({
  getParentRoute: () => root,
  path: "/work/$id",
  component: WorkPage,
});
const router = createRouter({
  history: createHashHistory(),
  routeTree: root.addChildren([
    createRoute({ getParentRoute: () => root, path: "/", component: InboxPage }),
    createRoute({ getParentRoute: () => root, path: "/settings", component: SettingsPage }),
    workRoute,
  ]),
});
declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

const el = document.getElementById("root");
if (el) {
  createRoot(el).render(
    <StrictMode>
      <QueryClientProvider client={qc}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </StrictMode>,
  );
}

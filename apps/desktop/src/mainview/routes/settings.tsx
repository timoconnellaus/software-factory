// This Mac (spec 40 M2): the supervised runner, the device key, open at login, sign out, and the
// app's version with Check for updates (spec 40 M4).
import { Button } from "@software-factory/ui/components/button";
import { Card } from "@software-factory/ui/components/card";
import { Checkbox } from "@software-factory/ui/components/checkbox";
import { Label } from "@software-factory/ui/components/label";
import { StatusDot } from "@software-factory/ui/components/status-dot";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import type { RunnerState, UpdateStatus } from "../../shared/rpc.ts";
import {
  type CheckAction,
  checkView,
  installedText,
  lastCheckedText,
} from "../../shared/update-check.ts";
import { bun, onRunner } from "../bridge.ts";
import { SignInAgainDialog } from "../components/key-notices.tsx";
import { PageArea, PageHeader } from "../components/shell-list.tsx";
import { useDesktopSession, useUpdateStatus } from "../lib/desktop-session.ts";
import { settingsLayout } from "./_settings.tsx";

export const Route = createRoute({
  getParentRoute: () => settingsLayout,
  path: "/settings",
  component: SettingsPage,
});

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

export function SettingsPage() {
  const client = useQueryClient();
  const session = useDesktopSession();
  const [confirmSignIn, setConfirmSignIn] = useState(false);
  const runner = useQuery({ queryKey: ["runner"], queryFn: () => bun.runnerState({}) });
  const login = useQuery({ queryKey: ["login-item"], queryFn: () => bun.loginItem({}) });
  useEffect(() => onRunner((s) => client.setQueryData(["runner"], s)), [client]);
  const r = runner.data;
  return (
    <PageArea>
      <PageHeader
        title="This Mac"
        sub="Yours, not the org's: this Mac's runner, how it proves it's you, and how it starts."
      />
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
            <pre className="overflow-x-auto rounded bg-muted p-2 font-mono text-xs">
              {r.lastLine}
            </pre>
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
        <UpdatesCard />
        <Card className="gap-3 px-5 py-4">
          <div className="font-semibold">This Mac</div>
          <div className="text-muted-foreground text-sm">
            {session?.keyStorage === "secure-enclave"
              ? "Decisions are signed by a key in this Mac's Secure Enclave: approving asks for Touch ID."
              : session?.keyUpgrade
                ? "This Mac signs with a software key, which can't approve gates."
                : "This build has a software key (not signed for the Secure Enclave)."}
          </div>
          {session?.keyUpgrade && (
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <span>This Mac can now keep its key in the Secure Enclave: sign in again.</span>
              <Button
                size="sm"
                className="w-fit"
                data-testid="sign-in-again"
                onClick={() => setConfirmSignIn(true)}
              >
                Sign in again…
              </Button>
              <SignInAgainDialog open={confirmSignIn} onOpenChange={setConfirmSignIn} />
            </div>
          )}
          <Label className="flex items-center gap-2 font-normal">
            <Checkbox
              checked={login.data?.enabled ?? false}
              onCheckedChange={async (v) =>
                client.setQueryData(["login-item"], await bun.loginItem({ enable: v === true }))
              }
              data-testid="login-item"
            />
            Open at login
          </Label>
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
    </PageArea>
  );
}

/**
 * The installed version and Check for updates. The main process runs the check and pushes each step
 * (updateChanged); a press while one runs joins it. Restart to update is the menu's own restart:
 * it waits for the runner, and cancels jobs only when the person picks "Restart now".
 */
function UpdatesCard() {
  const client = useQueryClient();
  const u = useUpdateStatus();
  const [pressed, setPressed] = useState<CheckAction | null>(null);
  // "Last checked 5 minutes ago" moves on while the page is open.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  if (!u) return null;
  const view = checkView(u);
  const act = async (action: CheckAction) => {
    setPressed(action);
    try {
      client.setQueryData<UpdateStatus>(["update"], await bun.updateAction({ action }));
    } finally {
      setPressed(null);
    }
  };
  return (
    <Card className="gap-3 px-5 py-4" data-testid="updates">
      <div className="font-semibold">Updates</div>
      <div className="grid gap-0.5">
        <div className="text-sm" data-testid="installed">
          {installedText(u)}
        </div>
        {u.phase !== "off" && (
          <div className="text-muted-foreground text-xs" data-testid="last-checked">
            {lastCheckedText(u.checkedAt, now)}
          </div>
        )}
      </div>
      {view.line && (
        <div
          className={`font-medium text-sm ${view.tone === "error" ? "text-destructive" : ""}`}
          data-testid="update-line"
          role="status"
        >
          {view.line}
        </div>
      )}
      {view.actions.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {view.actions.map((a) => (
            <Button
              key={a.action}
              size="sm"
              variant={a.variant}
              disabled={view.busy || pressed !== null}
              onClick={() => void act(a.action)}
            >
              {a.action === "check" && pressed === "check" ? "Checking…" : a.label}
            </Button>
          ))}
        </div>
      )}
    </Card>
  );
}

// This Mac (spec 40 M2): the supervised runner, the device key, open at login, sign out.
import { Button } from "@software-factory/ui/components/button";
import { Card } from "@software-factory/ui/components/card";
import { StatusDot } from "@software-factory/ui/components/status-dot";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createRoute } from "@tanstack/react-router";
import { useEffect } from "react";
import type { RunnerState } from "../../shared/rpc.ts";
import { bun, onRunner } from "../bridge.ts";
import { useDesktopSession } from "../lib/desktop-session.ts";
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
  const runner = useQuery({ queryKey: ["runner"], queryFn: () => bun.runnerState({}) });
  const login = useQuery({ queryKey: ["login-item"], queryFn: () => bun.loginItem({}) });
  useEffect(() => onRunner((s) => client.setQueryData(["runner"], s)), [client]);
  const r = runner.data;
  return (
    <main className="mx-auto grid w-full max-w-[1200px] gap-4 p-4 md:p-6">
      <h1 className="font-semibold text-2xl tracking-tight">This Mac</h1>
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
                client.setQueryData(
                  ["login-item"],
                  await bun.loginItem({ enable: e.target.checked }),
                )
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
    </main>
  );
}

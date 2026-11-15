// Settings (spec 70): This Mac and Members. This Mac is yours, not the org's: who is signed in and
// Sign out, the key that proves it's you, this Mac's runner with its controls, and the app's
// version with its updater. Members is the org's people, read-only for now.
import { Button } from "@software-factory/ui/components/button";
import { Checkbox } from "@software-factory/ui/components/checkbox";
import { Label } from "@software-factory/ui/components/label";
import { cn } from "@software-factory/ui/lib/utils";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import type { RunnerState, UpdateStatus } from "../../../shared/rpc.ts";
import {
  type CheckAction,
  checkView,
  installedText,
  lastCheckedText,
} from "../../../shared/update-check.ts";
import { bun, onRunner } from "../../bridge.ts";
import { useDesktopSession, useUpdateStatus } from "../../lib/desktop-session.ts";
import { useSession } from "../../lib/session.ts";
import { SignInAgainDialog } from "../key-notices.tsx";
import { MembersList } from "./members.tsx";
import { PageHeader } from "./parts.tsx";

export type SettingsTab = "mac" | "members";

export function SettingsPage({ orgId, tab }: { orgId: string; tab: SettingsTab }) {
  const navigate = useNavigate();
  return (
    <main className="flex min-w-0 flex-1 flex-col" data-testid="settings-page">
      <PageHeader
        title="Settings"
        tabs={["This Mac", "Members"]}
        tab={tab === "members" ? "Members" : "This Mac"}
        onTab={(t) =>
          void navigate({
            to: "/flow/$orgId/settings",
            params: { orgId },
            search: t === "Members" ? { tab: "members" as const } : {},
          })
        }
      />
      <div className="min-h-0 flex-1 overflow-auto bg-board p-5">
        {tab === "members" ? <MembersList orgId={orgId} /> : <ThisMac />}
      </div>
    </main>
  );
}

/** A titled card on Settings. */
function Panel({
  title,
  children,
  className,
  ...props
}: { title: string } & React.ComponentProps<"section">) {
  return (
    <section
      className={cn(
        "grid gap-2.5 rounded-[10px] border border-line bg-panel px-4 py-3.5",
        className,
      )}
      {...props}
    >
      <h2 className="font-semibold text-[13.5px]">{title}</h2>
      {children}
    </section>
  );
}

/** What this Mac's runner is doing, in plain words. */
export const RUNNER_TEXT: Record<RunnerState["status"], string> = {
  unpaired: "This Mac isn't set up to run agents yet.",
  launchd:
    "The runner is running as a background service. The app can run it instead: the same runner, as the same machine.",
  stopped: "Stopped. Agents won't run on this Mac until it starts.",
  starting: "Starting…",
  running: "Running. Agents can do work on this Mac.",
  restarting: "Restarting…",
  locked: "Another copy of the runner is running on this Mac. The app waits for it to stop.",
  failed: "It stopped with an error. Restart it to try again.",
};

function ThisMac() {
  const client = useQueryClient();
  const session = useSession();
  const desktop = useDesktopSession();
  const [confirmSignIn, setConfirmSignIn] = useState(false);
  const runner = useQuery({ queryKey: ["runner"], queryFn: () => bun.runnerState({}) });
  const login = useQuery({ queryKey: ["login-item"], queryFn: () => bun.loginItem({}) });
  useEffect(() => onRunner((s) => client.setQueryData(["runner"], s)), [client]);
  const r = runner.data;
  const who = session.user.githubLogin ?? desktop?.login ?? "you";
  return (
    <div className="grid max-w-2xl gap-3">
      <Panel title="Account" data-testid="account">
        <div className="flex items-center gap-3">
          <span className="text-ink-muted">
            Signed in as <span className="font-medium text-ink">@{who}</span> on this Mac.
          </span>
          <Button
            size="md"
            variant="outline"
            className="ml-auto"
            onClick={async () => client.setQueryData(["session"], await bun.signOut({}))}
            data-testid="settings-sign-out"
          >
            Sign out
          </Button>
        </div>
      </Panel>
      <Panel title="This Mac's key" data-testid="device-key">
        <p className="text-ink-muted">
          {desktop?.keyStorage === "secure-enclave"
            ? "Your decisions are signed by a key in this Mac's Secure Enclave: approving asks for Touch ID."
            : desktop?.keyUpgrade
              ? "This Mac signs with a software key, which can't approve."
              : "This build signs with a software key, not one in the Secure Enclave."}
        </p>
        {desktop?.keyUpgrade && (
          <div className="flex flex-wrap items-center gap-3">
            <span>This Mac can now keep its key in the Secure Enclave: sign in again.</span>
            <Button size="md" data-testid="sign-in-again" onClick={() => setConfirmSignIn(true)}>
              Sign in again…
            </Button>
            <SignInAgainDialog open={confirmSignIn} onOpenChange={setConfirmSignIn} />
          </div>
        )}
      </Panel>
      <Panel title="Runner on this Mac" data-testid="runner">
        <div className="flex items-center gap-2">
          <span
            aria-hidden
            className={cn(
              "size-2 flex-none rounded-full",
              r?.status === "running"
                ? "bg-ok"
                : r?.status === "failed"
                  ? "bg-bad"
                  : "bg-line-strong",
            )}
          />
          <span data-testid="runner-status">{r ? RUNNER_TEXT[r.status] : "…"}</span>
        </div>
        {r?.lastLine && (
          <pre className="overflow-x-auto rounded-md bg-field px-2.5 py-2 font-mono text-[11.5px]">
            {r.lastLine}
          </pre>
        )}
        {(r?.status === "unpaired" ||
          r?.status === "launchd" ||
          r?.status === "running" ||
          r?.status === "failed") && (
          <div className="flex gap-2">
            {r.status === "unpaired" && (
              <Button size="md" onClick={() => bun.runnerAction({ action: "pair" })}>
                Set up this Mac
              </Button>
            )}
            {r.status === "launchd" && (
              <Button size="md" onClick={() => bun.runnerAction({ action: "takeover" })}>
                Run it in the app
              </Button>
            )}
            {(r.status === "running" || r.status === "failed") && (
              <Button
                size="md"
                variant="outline"
                onClick={() => bun.runnerAction({ action: "restart" })}
              >
                Restart
              </Button>
            )}
          </div>
        )}
      </Panel>
      <Updates />
      <Label className="flex items-center gap-2 px-1 font-normal">
        <Checkbox
          checked={login.data?.enabled ?? false}
          onCheckedChange={async (v) =>
            client.setQueryData(["login-item"], await bun.loginItem({ enable: v === true }))
          }
          data-testid="login-item"
        />
        Open the app when you log in to this Mac
      </Label>
    </div>
  );
}

/**
 * The installed version and Check for updates. The main process runs the check and pushes each step
 * (updateChanged); a press while one runs joins it. Restart to update is the menu's own restart:
 * it waits for the runner, and cancels jobs only when the person picks "Restart now".
 */
function Updates() {
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
    <Panel title="The app" data-testid="updates">
      <div className="grid gap-0.5">
        <div data-testid="installed">{installedText(u)}</div>
        {u.phase !== "off" && (
          <div className="text-[12px] text-ink-muted" data-testid="last-checked">
            {lastCheckedText(u.checkedAt, now)}
          </div>
        )}
      </div>
      {view.line && (
        <div
          className={cn("font-medium", view.tone === "error" && "text-bad")}
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
              size="md"
              variant={a.variant}
              disabled={view.busy || pressed !== null}
              onClick={() => void act(a.action)}
            >
              {a.action === "check" && pressed === "check" ? "Checking…" : a.label}
            </Button>
          ))}
        </div>
      )}
    </Panel>
  );
}

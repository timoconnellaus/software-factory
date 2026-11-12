// Approve a desktop app sign-in (ADR 0391, spec 40 M1): the app opens this page as
// `/desktop/connect?request=…`. The person checks the device name and key fingerprint match what
// the app shows, and approves. The page then hands the one-time code back to the app through
// `sf://auth/callback`. The app can decide gates only with Touch ID for each decision.
import { Button } from "@software-factory/ui/components/button";
import { Card } from "@software-factory/ui/components/card";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { op, submitKey } from "#/lib/op";
import { OpError } from "#/lib/ops";

const REQUEST = /^dar_[0-9a-f]{32}$/;

export const Route = createFileRoute("/_app/desktop/connect")({
  validateSearch: (s: Record<string, unknown>): { request?: string } =>
    typeof s.request === "string" ? { request: s.request } : {},
  component: ConnectDesktopPage,
});

function ConnectDesktopPage() {
  const { request } = Route.useSearch();
  return (
    <main className="mx-auto grid w-full grid-cols-[minmax(0,1fr)] max-w-[560px] gap-4 p-4 md:p-6">
      <div>
        <h1 className="font-semibold text-2xl tracking-tight">Sign in the desktop app</h1>
        <p className="text-muted-foreground text-sm">
          Only approve a sign-in you started from Software Factory on your Mac.
        </p>
      </div>
      {request && REQUEST.test(request) ? (
        <Approve requestId={request} />
      ) : (
        <Card className="px-5 py-4 text-sm" data-testid="desktop-device-missing">
          Start the sign-in from the desktop app: it opens this page for you.
        </Card>
      )}
    </main>
  );
}

function Approve({ requestId }: { requestId: string }) {
  const lookup = useQuery({
    queryKey: ["desktop-device", requestId],
    queryFn: () => op("desktop.authLookup", { requestId }),
    retry: false,
  });
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<
    { kind: "approved"; url: string } | { kind: "denied" } | null
  >(null);

  async function decide(approve: boolean) {
    setBusy(true);
    try {
      if (approve) {
        const out = await op(
          "desktop.approveDevice",
          { requestId },
          { idempotencyKey: submitKey() },
        );
        setResult({ kind: "approved", url: out.redirectUrl });
        // Hand the code back to the app.
        window.location.href = out.redirectUrl;
      } else {
        await op("desktop.denyDevice", { requestId }, { idempotencyKey: submitKey() });
        setResult({ kind: "denied" });
      }
    } catch (error) {
      toast.error(error instanceof OpError ? error.message : "Something went wrong");
      await lookup.refetch();
    } finally {
      setBusy(false);
    }
  }

  if (lookup.isPending) return <Card className="px-5 py-4 text-sm">Looking up the sign-in…</Card>;
  if (lookup.isError) {
    return (
      <Card className="px-5 py-4 text-sm" data-testid="desktop-device-error">
        {lookup.error instanceof OpError ? lookup.error.message : "Couldn't look up this sign-in"}.
      </Card>
    );
  }
  if (result?.kind === "approved") {
    return (
      <Card className="gap-1 px-5 py-4 text-sm" data-testid="desktop-device-approved">
        <div className="font-medium">Approved</div>
        <div className="text-muted-foreground">
          The app finishes signing in. If it didn't open,{" "}
          <a href={result.url} className="underline">
            open Software Factory
          </a>
          .
        </div>
      </Card>
    );
  }
  if (result?.kind === "denied") {
    return (
      <Card className="px-5 py-4 text-sm" data-testid="desktop-device-denied">
        Denied. That sign-in can't be completed.
      </Card>
    );
  }
  const d = lookup.data;
  if (d.status !== "pending") {
    return (
      <Card className="px-5 py-4 text-sm" data-testid="desktop-device-done">
        {d.status === "expired"
          ? "This sign-in expired. Start again from the app."
          : "This sign-in was already decided. Start again from the app."}
      </Card>
    );
  }
  return (
    <Card className="gap-4 px-5 py-4" data-testid="desktop-device-approve">
      <div className="grid gap-1">
        <div className="text-muted-foreground text-xs">Device</div>
        <div className="font-medium text-lg" data-testid="desktop-device-name">
          {d.deviceName}
        </div>
        <div className="text-muted-foreground text-xs">
          Key <span className="font-mono">{d.keyFingerprint}</span>
          {d.keyStorage === "secure-enclave" ? " (Secure Enclave)" : " (software key: dev build)"}.
          Check it matches the app. Expires {new Date(d.expiresAt).toLocaleTimeString()}.
        </div>
      </div>
      <p className="text-muted-foreground text-xs">
        The app acts as you: it sees your work and can create, attach and cancel it. Approving a
        spec or a merge, or answering a question, also needs Touch ID on that Mac each time.
        Approving other logins and turning a kill switch off stay on this website.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy} onClick={() => decide(true)} data-testid="approve-desktop-device">
          Approve
        </Button>
        <Button variant="ghost" disabled={busy} onClick={() => decide(false)}>
          Deny
        </Button>
      </div>
    </Card>
  );
}

// Approve a phone's browser sign-in (ADR 0541, spec 60): the phone opens this page in a Custom Tab
// as `/mobile/connect?request=…`. The person checks the phone's name, where its key lives and the
// key's fingerprint against what the phone shows, and approves. The page then hands the one-time
// code back to the phone through the App Link `/mobile/callback`. The phone approves merges, plans
// and policy changes only with a fingerprint each time.
import { Button } from "@software-factory/ui/components/button";
import { Card } from "@software-factory/ui/components/card";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { keyStorageLabel } from "#/lib/mobile";
import { op, submitKey } from "#/lib/op";
import { OpError } from "#/lib/ops";

const REQUEST = /^dar_[0-9a-f]{32}$/;

export const Route = createFileRoute("/_app/mobile/connect")({
  validateSearch: (s: Record<string, unknown>): { request?: string } =>
    typeof s.request === "string" ? { request: s.request } : {},
  component: ConnectPhonePage,
});

function ConnectPhonePage() {
  const { request } = Route.useSearch();
  return (
    <main className="mx-auto grid w-full grid-cols-[minmax(0,1fr)] max-w-[560px] gap-4 p-4 md:p-6">
      <div>
        <h1 className="font-semibold text-2xl tracking-tight">Sign in the phone app</h1>
        <p className="text-muted-foreground text-sm">
          Only approve a sign-in you started from Software Factory on your phone.
        </p>
      </div>
      {request && REQUEST.test(request) ? (
        <Approve requestId={request} />
      ) : (
        <Card className="px-5 py-4 text-sm" data-testid="phone-missing">
          Start the sign-in from the phone app: it opens this page for you.
        </Card>
      )}
    </main>
  );
}

function Approve({ requestId }: { requestId: string }) {
  const lookup = useQuery({
    queryKey: ["mobile-device", requestId],
    queryFn: () => op("mobile.authLookup", { requestId }),
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
          "mobile.approveDevice",
          { requestId },
          { idempotencyKey: submitKey() },
        );
        setResult({ kind: "approved", url: out.redirectUrl });
        // Hand the code back to the phone: the App Link opens the app.
        window.location.href = out.redirectUrl;
      } else {
        await op("mobile.denyDevice", { requestId }, { idempotencyKey: submitKey() });
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
      <Card className="px-5 py-4 text-sm" data-testid="phone-error">
        {lookup.error instanceof OpError ? lookup.error.message : "Couldn't look up this sign-in"}.
      </Card>
    );
  }
  if (result?.kind === "approved") {
    return (
      <Card className="gap-1 px-5 py-4 text-sm" data-testid="phone-approved">
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
      <Card className="px-5 py-4 text-sm" data-testid="phone-denied">
        Denied. That sign-in can't be completed.
      </Card>
    );
  }
  const d = lookup.data;
  if (d.status !== "pending") {
    return (
      <Card className="px-5 py-4 text-sm" data-testid="phone-done">
        {d.status === "expired"
          ? "This sign-in expired. Start again on the phone."
          : "This sign-in was already decided. Start again on the phone."}
      </Card>
    );
  }
  const patch = d.attestation?.osPatchLevel;
  return (
    <Card className="gap-4 px-5 py-4" data-testid="phone-approve">
      <div className="grid gap-1">
        <div className="text-muted-foreground text-xs">Phone</div>
        <div className="font-medium text-lg" data-testid="phone-name">
          {d.deviceName}
        </div>
        <div className="text-muted-foreground text-xs">
          Key <span className="font-mono">{d.keyFingerprint}</span>, {keyStorageLabel(d.keyStorage)}
          {patch
            ? `, security patch ${String(patch).slice(0, 4)}-${String(patch).slice(4, 6)}`
            : ""}
          . Check it matches the phone. Expires {new Date(d.expiresAt).toLocaleTimeString()}.
        </div>
        {d.attestation?.downgraded && (
          <div
            className="text-amber-600 text-xs dark:text-amber-400"
            data-testid="phone-cant-approve"
          >
            This phone can sign in but can't approve anything: {d.attestation.downgraded}.
          </div>
        )}
      </div>
      <p className="text-muted-foreground text-xs">
        The app acts as you: it sees your work, captures ideas, answers questions and sends work
        back. Merging, approving a plan or a policy change also needs your fingerprint on that phone
        each time. Approving other logins and turning a kill switch off stay on this website.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy} onClick={() => decide(true)} data-testid="approve-phone">
          Approve
        </Button>
        <Button variant="ghost" disabled={busy} onClick={() => decide(false)}>
          Deny
        </Button>
      </div>
    </Card>
  );
}

// Your devices and Add a phone (ADR 0541, spec 60 PR 1a). The list is device.list; Remove is
// device.revoke. Add a phone makes a pair offer (mobile.pairOffer, which is the approval: one use,
// 5 minutes), draws its QR code here in the browser, shows the typed code, and watches the offer
// (mobile.pairOfferStatus) until a phone pairs. Then it shows the phone's name, where its key lives
// and **Not my phone? Remove**.
import { Badge } from "@software-factory/ui/components/badge";
import { Button } from "@software-factory/ui/components/button";
import { Card } from "@software-factory/ui/components/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@software-factory/ui/components/dialog";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { LaptopIcon, SmartphoneIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { renderSVG } from "uqr";
import { keyStorageLabel } from "#/lib/mobile";
import { op, submitKey } from "#/lib/op";
import { OpError, type OpOutput } from "#/lib/ops";

export const devicesQuery = () => ({
  queryKey: ["devices"],
  queryFn: () => op("device.list", {}),
});

type Device = OpOutput<"device.list">["devices"][number];

export function DevicesList() {
  const devices = useQuery(devicesQuery());
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const live = (devices.data?.devices ?? []).filter((d) => !d.revokedAt);

  async function remove(d: Device) {
    try {
      await op("device.revoke", { deviceId: d.id }, { idempotencyKey: submitKey() });
      toast.success(`Removed ${d.name}`);
    } catch (error) {
      toast.error(error instanceof OpError ? error.message : "Couldn't remove it");
    }
    await queryClient.invalidateQueries({ queryKey: ["devices"] });
  }

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-muted-foreground text-sm">
          Macs and phones signed in as you. Each can approve only with Touch ID or a fingerprint.
        </p>
        <Button onClick={() => setAdding(true)} data-testid="add-phone">
          <SmartphoneIcon />
          Add a phone
        </Button>
      </div>
      <Card className="gap-0 divide-y py-0" data-testid="devices-list">
        {devices.isPending && <div className="px-5 py-4 text-sm">Loading…</div>}
        {devices.data && live.length === 0 && (
          <div className="px-5 py-4 text-muted-foreground text-sm">
            No devices yet. Sign in to the desktop app, or add a phone.
          </div>
        )}
        {live.map((d) => (
          <div key={d.id} className="flex items-center gap-3 px-5 py-3" data-testid="device-row">
            {d.platform === "android" ? (
              <SmartphoneIcon className="size-4 shrink-0 text-muted-foreground" />
            ) : (
              <LaptopIcon className="size-4 shrink-0 text-muted-foreground" />
            )}
            <div className="grid min-w-0 flex-1 gap-0.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="truncate font-medium text-sm">{d.name}</span>
                {!d.decides && <Badge variant="secondary">approvals off</Badge>}
              </div>
              <div className="text-muted-foreground text-xs">
                {d.platform === "android" ? "Android" : "Mac"}, key {keyStorageLabel(d.keyStorage)}.
                Added {new Date(d.createdAt).toLocaleDateString()}
                {d.lastSeenAt
                  ? `, last approved ${new Date(d.lastSeenAt).toLocaleDateString()}`
                  : ""}
                .
              </div>
            </div>
            <Button variant="ghost" size="sm" onClick={() => remove(d)}>
              Remove
            </Button>
          </div>
        ))}
      </Card>
      <AddPhoneDialog
        open={adding}
        onOpenChange={(open) => {
          setAdding(open);
          if (!open) void queryClient.invalidateQueries({ queryKey: ["devices"] });
        }}
      />
    </div>
  );
}

type Offer = OpOutput<"mobile.pairOffer">;

export function AddPhoneDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [offer, setOffer] = useState<Offer | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setOffer(null);
      setError(null);
      return;
    }
    let cancelled = false;
    op("mobile.pairOffer", {}, { idempotencyKey: submitKey() })
      .then((o) => !cancelled && setOffer(o))
      .catch(
        (e) => !cancelled && setError(e instanceof OpError ? e.message : "Couldn't make a code"),
      );
    return () => {
      cancelled = true;
    };
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" data-testid="add-phone-dialog">
        <DialogHeader>
          <DialogTitle>Add a phone</DialogTitle>
          <DialogDescription>
            In the Software Factory app, choose <span className="font-medium">Scan a code</span>.
            The code works once, for 5 minutes.
          </DialogDescription>
        </DialogHeader>
        {error && <p className="text-destructive text-sm">{error}</p>}
        {!offer && !error && <p className="text-muted-foreground text-sm">Making a code…</p>}
        {offer && <OfferView offer={offer} onDone={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  );
}

function OfferView({ offer, onDone }: { offer: Offer; onDone: () => void }) {
  const queryClient = useQueryClient();
  const status = useQuery({
    queryKey: ["pair-offer", offer.offerId],
    queryFn: () => op("mobile.pairOfferStatus", { offerId: offer.offerId }),
    refetchInterval: (q) =>
      q.state.data && q.state.data.status !== "waiting" && q.state.data.status !== "pairing"
        ? false
        : 2_000,
  });
  // Drawn here, from the offer: the secret never leaves this page except into the QR.
  const svg = useMemo(
    () => renderSVG(offer.pairUrl, { border: 2, whiteColor: "#ffffff", blackColor: "#000000" }),
    [offer.pairUrl],
  );
  const s = status.data;

  async function remove(deviceId: string) {
    try {
      await op("device.revoke", { deviceId }, { idempotencyKey: submitKey() });
      toast.success("Removed. That phone can't do anything now.");
      await queryClient.invalidateQueries({ queryKey: ["devices"] });
      await status.refetch();
    } catch (error) {
      toast.error(error instanceof OpError ? error.message : "Couldn't remove it");
    }
  }

  if (s?.status === "paired" && s.device) {
    const d = s.device;
    return (
      <div className="grid gap-4" data-testid="phone-paired">
        <div className="grid gap-1 rounded-md border px-4 py-3">
          <div className="flex items-center gap-2">
            <SmartphoneIcon className="size-4 text-muted-foreground" />
            <span className="font-medium">{d.name}</span>
            {d.revoked && <Badge variant="secondary">removed</Badge>}
          </div>
          <div className="text-muted-foreground text-xs">
            Paired. Key {keyStorageLabel(d.keyStorage)}
            {d.attestation?.downgraded ? ` (${d.attestation.downgraded})` : ""}.
          </div>
        </div>
        <DialogFooter className="items-center sm:justify-between">
          {!d.revoked && (
            <Button variant="link" className="px-0 text-destructive" onClick={() => remove(d.id)}>
              Not my phone? Remove
            </Button>
          )}
          <Button onClick={onDone}>Done</Button>
        </DialogFooter>
      </div>
    );
  }
  if (s && (s.status === "expired" || s.status === "closed")) {
    return (
      <p className="text-muted-foreground text-sm" data-testid="offer-ended">
        {s.status === "expired"
          ? "This code expired. Close this and add a phone again."
          : "Too many wrong codes were typed, so this one is closed. Close this and try again."}
      </p>
    );
  }
  return (
    <div className="grid justify-items-center gap-4" data-testid="pair-offer">
      <div
        className="size-56 rounded-md bg-white p-1 [&_svg]:size-full"
        role="img"
        aria-label="Pairing QR code"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: an SVG drawn by uqr from our own offer URL, no outside input.
        dangerouslySetInnerHTML={{ __html: svg }}
      />
      <div className="grid justify-items-center gap-1">
        <div className="text-muted-foreground text-xs">Or type this code in the app</div>
        <div className="font-mono font-semibold text-2xl tracking-widest" data-testid="pair-code">
          {offer.code}
        </div>
        <div className="text-muted-foreground text-xs">
          {s?.status === "pairing"
            ? "A phone is pairing…"
            : `Expires ${new Date(offer.expiresAt).toLocaleTimeString()}`}
        </div>
        {s && s.wrongTries > 0 && (
          <div className="text-muted-foreground text-xs" data-testid="pair-wrong-tries">
            {s.wrongTries} wrong {s.wrongTries === 1 ? "try" : "tries"} so far, of {s.maxWrongTries}
          </div>
        )}
      </div>
    </div>
  );
}

// Settings: Devices (spec 41, slice 6; design SettingsDevices). Yours, not the org's: the desktop
// devices and CLI tokens that can act as you, this Mac first, and revoking any other one
// (`desktopDevice.revoke`, `cliToken.revoke`). This Mac signs out from This Mac instead. Runners are
// under Factory. The design's notifications have no operation yet, so they aren't here.
import { ago, duration } from "@software-factory/client/format";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@software-factory/ui/components/alert-dialog";
import { Button } from "@software-factory/ui/components/button";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { Cell, Empty, Row, TablePanel, WIDE } from "../components/data-table.tsx";
import { Chip, PageArea, PageHeader } from "../components/shell-list.tsx";
import { useDesktopSession } from "../lib/desktop-session.ts";
import { devicesQuery } from "../lib/factory-queries.ts";
import { op, submitKey } from "../lib/op.ts";
import { type DeviceRow, deviceRows } from "../lib/settings-view.ts";
import { settingsLayout } from "./_settings.tsx";

export const Route = createRoute({
  getParentRoute: () => settingsLayout,
  path: "/settings/devices",
  loader: ({ context: { queryClient } }) =>
    queryClient.ensureQueryData(devicesQuery()).catch(() => null),
  component: DevicesPage,
});

function DevicesPage() {
  const desktop = useDesktopSession();
  const data = useQuery(devicesQuery());
  const rows = data.data
    ? deviceRows(data.data.devices, data.data.tokens, desktop?.deviceId ?? null)
    : [];
  return (
    <PageArea>
      <PageHeader
        title="Devices"
        sub="Yours, not the org's: where you are signed in. Revoking one stops its token at once."
      />
      {data.error ? (
        <Empty>Couldn't read your devices: {data.error.message}</Empty>
      ) : rows.length === 0 ? (
        <Empty>{data.isPending ? "Loading…" : "No devices."}</Empty>
      ) : (
        <TablePanel
          head={[
            "Device",
            { label: "Can", className: WIDE },
            "Approves with",
            { label: "Last used", className: WIDE },
            "",
          ]}
          data-testid="devices"
        >
          {rows.map((r) => (
            <Row key={r.id} data-testid={`device-${r.id}`}>
              <Cell className="min-w-[170px] whitespace-normal">
                <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                  <span className="font-medium">
                    {r.kind === "cli" ? `sf CLI: ${r.name}` : `Desktop app on ${r.name}`}
                  </span>
                  {r.thisDevice && <Chip tone="blue">This Mac</Chip>}
                  {r.expires && (
                    <span className="w-full text-ink-muted text-xs">
                      Expires in {duration(Date.parse(r.expires) - Date.now())}
                    </span>
                  )}
                </span>
              </Cell>
              <Cell className={WIDE}>{r.can}</Cell>
              <Cell>{r.proves}</Cell>
              <Cell className={`text-ink-3 ${WIDE}`}>
                {r.thisDevice
                  ? "Now"
                  : r.lastUsed
                    ? ago(r.lastUsed)
                    : r.kind === "cli"
                      ? "Not recorded"
                      : "Never"}
              </Cell>
              <Cell className="text-right">
                {r.thisDevice ? (
                  <Link to="/settings" className="text-ink-3 text-xs underline">
                    Sign out…
                  </Link>
                ) : (
                  <Revoke row={r} />
                )}
              </Cell>
            </Row>
          ))}
        </TablePanel>
      )}
      <div className="text-ink-3 text-xs">
        Runners are under{" "}
        <Link to="/factory/runners" className="text-ink underline">
          Factory: Runners
        </Link>
        . A runner never holds your GitHub credentials.
      </div>
    </PageArea>
  );
}

function Revoke({ row }: { row: DeviceRow }) {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const what =
    row.kind === "cli" ? `the sf CLI token "${row.name}"` : `the desktop app on ${row.name}`;
  async function revoke() {
    setBusy(true);
    try {
      const key = { idempotencyKey: submitKey() };
      const res =
        row.kind === "cli"
          ? await op("cliToken.revoke", { tokenId: row.id }, key)
          : await op("desktopDevice.revoke", { deviceId: row.id }, key);
      toast(res.revoked ? "Revoked." : "It was already revoked.");
      await client.invalidateQueries({ queryKey: ["devices"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button
          size="md"
          variant="outline"
          className="text-destructive"
          disabled={busy}
          data-testid="revoke"
        >
          Revoke
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Revoke {what}?</AlertDialogTitle>
          <AlertDialogDescription>
            Its token stops working at once and it can't decide anything. Signing in there again
            makes a new one.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={() => void revoke()}>Revoke</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

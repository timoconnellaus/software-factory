// Settings → Devices (ADR 0541, spec 60 PR 1a): the Macs and phones signed in as you, Remove, and
// Add a phone. The website keeps device pages under ADR 0392.
import { createFileRoute } from "@tanstack/react-router";
import { DevicesList, devicesQuery } from "#/components/devices";

export const Route = createFileRoute("/_app/settings/devices")({
  loader: ({ context }) => context.queryClient.ensureQueryData(devicesQuery()).catch(() => null),
  component: DevicesPage,
});

function DevicesPage() {
  return (
    <main className="mx-auto grid w-full grid-cols-[minmax(0,1fr)] max-w-[720px] gap-4 p-4 md:p-6">
      <div>
        <h1 className="font-semibold text-2xl tracking-tight">Devices</h1>
      </div>
      <DevicesList />
    </main>
  );
}

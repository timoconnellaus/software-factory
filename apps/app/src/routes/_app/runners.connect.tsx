// Approve a runner's login code (ADR 0056): `sf-runner login` prints a code and a link here
// (`/runners/connect?code=…`). The person checks the code matches their terminal, names the runner
// and approves; the waiting CLI then receives its key. Nothing to copy.

import { LOGIN_COMMAND } from "@software-factory/client/runner-pairing";
import { Button } from "@software-factory/ui/components/button";
import { Card } from "@software-factory/ui/components/card";
import { Input } from "@software-factory/ui/components/input";
import { Label } from "@software-factory/ui/components/label";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { type FormEvent, useEffect, useState } from "react";
import { toast } from "sonner";
import { op, submitKey } from "#/lib/op";
import { OpError } from "#/lib/ops";

export const Route = createFileRoute("/_app/runners/connect")({
  validateSearch: (s: Record<string, unknown>): { code?: string } =>
    typeof s.code === "string" ? { code: s.code } : {},
  component: ConnectRunnerPage,
});

const CODE = /^[A-Za-z0-9]{4}-?[A-Za-z0-9]{4}$/;

function ConnectRunnerPage() {
  const { code } = Route.useSearch();
  return (
    <main className="mx-auto grid w-full grid-cols-[minmax(0,1fr)] max-w-[560px] gap-4 p-4 md:p-6">
      <div>
        <h1 className="font-semibold text-2xl tracking-tight">Connect a runner</h1>
        <p className="text-muted-foreground text-sm">
          Approve the code <span className="font-mono text-xs">{LOGIN_COMMAND}</span> shows in your
          terminal. Only approve a code you started yourself.
        </p>
      </div>
      {code && CODE.test(code.trim()) ? <Approve code={code.trim()} /> : <EnterCode />}
    </main>
  );
}

function EnterCode() {
  const navigate = useNavigate();
  const [value, setValue] = useState("");
  function submit(e: FormEvent) {
    e.preventDefault();
    void navigate({ to: "/runners/connect", search: { code: value.trim().toUpperCase() } });
  }
  return (
    <Card className="px-5 py-4">
      <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
        <div className="grid gap-1.5">
          <Label htmlFor="code">Code from the terminal</Label>
          <Input
            id="code"
            className="w-40 font-mono uppercase"
            placeholder="XXXX-XXXX"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            required
            pattern="[A-Za-z0-9]{4}-?[A-Za-z0-9]{4}"
          />
        </div>
        <Button type="submit">Continue</Button>
      </form>
    </Card>
  );
}

function Approve({ code }: { code: string }) {
  const queryClient = useQueryClient();
  const lookup = useQuery({
    queryKey: ["device", code],
    queryFn: () => op("runner.deviceLookup", { userCode: code }),
    retry: false,
  });
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<"approved" | "denied" | null>(null);
  useEffect(() => {
    if (lookup.data?.suggestedName && !name) setName(lookup.data.suggestedName);
  }, [lookup.data, name]);

  async function decide(approve: boolean) {
    setBusy(true);
    try {
      if (approve) {
        await op(
          "runner.approveDevice",
          { userCode: code, name: name.trim() },
          { idempotencyKey: submitKey() },
        );
      } else {
        await op("runner.denyDevice", { userCode: code }, { idempotencyKey: submitKey() });
      }
      setResult(approve ? "approved" : "denied");
      await Promise.all(
        ["runners", "setup", "inbox"].map((k) => queryClient.invalidateQueries({ queryKey: [k] })),
      );
    } catch (error) {
      toast.error(error instanceof OpError ? error.message : "Something went wrong");
      await lookup.refetch();
    } finally {
      setBusy(false);
    }
  }

  if (lookup.isPending) return <Card className="px-5 py-4 text-sm">Looking up {code}…</Card>;
  if (lookup.isError) {
    return (
      <Card className="px-5 py-4 text-sm" data-testid="device-error">
        {lookup.error instanceof OpError ? lookup.error.message : "Couldn't look up that code"}.{" "}
        <Link to="/runners/connect" search={{}} className="underline">
          Enter another code
        </Link>
      </Card>
    );
  }
  if (result) {
    return (
      <Card className="gap-1 px-5 py-4 text-sm" data-testid={`device-${result}`}>
        <div className="font-medium">
          {result === "approved" ? `Approved: ${name.trim()}` : "Denied"}
        </div>
        <div className="text-muted-foreground">
          {result === "approved"
            ? "Your terminal finishes on its own: it saves the key and installs the runner service."
            : "The login in that terminal stops."}{" "}
          <Link to="/setup" search={{}} className="underline">
            Back to Setup
          </Link>
        </div>
      </Card>
    );
  }
  const d = lookup.data;
  if (d.status !== "pending") {
    return (
      <Card className="px-5 py-4 text-sm" data-testid="device-done">
        {d.status === "expired"
          ? "This code expired. Run the login command again for a new one."
          : d.decidedByYou
            ? `You already ${d.status === "denied" ? "denied" : "approved"} this code.`
            : "This code was already used. Run the login command again for a new one."}
      </Card>
    );
  }
  return (
    <Card className="gap-4 px-5 py-4" data-testid="device-approve">
      <div className="grid gap-1">
        <div className="text-muted-foreground text-xs">Code</div>
        <div className="font-mono text-2xl tracking-widest" data-testid="device-code">
          {d.userCode}
        </div>
        <div className="text-muted-foreground text-xs">
          Check it matches your terminal. Expires {new Date(d.expiresAt).toLocaleTimeString()}.
        </div>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="runner-name">Runner name</Label>
        <Input
          id="runner-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="m5"
          maxLength={80}
        />
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={busy || !name.trim()}
          onClick={() => decide(true)}
          data-testid="approve-device"
        >
          Approve
        </Button>
        <Button variant="ghost" disabled={busy} onClick={() => decide(false)}>
          Deny
        </Button>
      </div>
    </Card>
  );
}

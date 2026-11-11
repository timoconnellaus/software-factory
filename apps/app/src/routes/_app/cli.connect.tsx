// Approve an `sf login` code (ADR 0340, spec 07): the CLI prints a code and a link here
// (`/cli/connect?code=…`). The person checks the code matches their terminal and picks what the
// token may do: read (see work; the right choice for an agent session) or write (also create,
// attach and cancel). Either way it can never decide a gate: approvals stay in this app.
import { Button } from "@software-factory/ui/components/button";
import { Card } from "@software-factory/ui/components/card";
import { Input } from "@software-factory/ui/components/input";
import { Label } from "@software-factory/ui/components/label";
import { RadioGroup, RadioGroupItem } from "@software-factory/ui/components/radio-group";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { type FormEvent, useEffect, useState } from "react";
import { toast } from "sonner";
import { op, submitKey } from "#/lib/op";
import { OpError } from "#/lib/ops";

export const Route = createFileRoute("/_app/cli/connect")({
  validateSearch: (s: Record<string, unknown>): { code?: string } =>
    typeof s.code === "string" ? { code: s.code } : {},
  component: ConnectCliPage,
});

const CODE = /^[A-Za-z0-9]{4}-?[A-Za-z0-9]{4}$/;
type Scope = "read" | "write";

function ConnectCliPage() {
  const { code } = Route.useSearch();
  return (
    <main className="mx-auto grid w-full grid-cols-[minmax(0,1fr)] max-w-[560px] gap-4 p-4 md:p-6">
      <div>
        <h1 className="font-semibold text-2xl tracking-tight">Sign in the sf CLI</h1>
        <p className="text-muted-foreground text-sm">
          Approve the code <span className="font-mono text-xs">sf login</span> shows in your
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
    void navigate({ to: "/cli/connect", search: { code: value.trim().toUpperCase() } });
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
  const lookup = useQuery({
    queryKey: ["cli-device", code],
    queryFn: () => op("cli.deviceLookup", { userCode: code }),
    retry: false,
  });
  // Read unless the terminal asked for write; the person decides either way.
  const [scope, setScope] = useState<Scope>("read");
  useEffect(() => {
    if (lookup.data?.requestedScope) setScope(lookup.data.requestedScope);
  }, [lookup.data?.requestedScope]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<"approved" | "denied" | null>(null);

  async function decide(approve: boolean) {
    setBusy(true);
    try {
      if (approve) {
        await op("cli.approveDevice", { userCode: code, scope }, { idempotencyKey: submitKey() });
      } else {
        await op("cli.denyDevice", { userCode: code }, { idempotencyKey: submitKey() });
      }
      setResult(approve ? "approved" : "denied");
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
      <Card className="px-5 py-4 text-sm" data-testid="cli-device-error">
        {lookup.error instanceof OpError ? lookup.error.message : "Couldn't look up that code"}.{" "}
        <Link to="/cli/connect" search={{}} className="underline">
          Enter another code
        </Link>
      </Card>
    );
  }
  if (result) {
    return (
      <Card className="gap-1 px-5 py-4 text-sm" data-testid={`cli-device-${result}`}>
        <div className="font-medium">
          {result === "approved"
            ? `Approved: ${scope === "read" ? "read only" : "read and write"}`
            : "Denied"}
        </div>
        <div className="text-muted-foreground">
          {result === "approved"
            ? "Your terminal finishes on its own. Revoke the token any time with `sf logout`."
            : "The login in that terminal stops."}
        </div>
      </Card>
    );
  }
  const d = lookup.data;
  if (d.status !== "pending") {
    return (
      <Card className="px-5 py-4 text-sm" data-testid="cli-device-done">
        {d.status === "expired"
          ? "This code expired. Run `sf login` again for a new one."
          : d.decidedByYou
            ? `You already ${d.status === "denied" ? "denied" : "approved"} this code.`
            : "This code was already used. Run `sf login` again for a new one."}
      </Card>
    );
  }
  return (
    <Card className="gap-4 px-5 py-4" data-testid="cli-device-approve">
      <div className="grid gap-1">
        <div className="text-muted-foreground text-xs">Code</div>
        <div className="font-mono text-2xl tracking-widest" data-testid="cli-device-code">
          {d.userCode}
        </div>
        <div className="text-muted-foreground text-xs">
          {d.clientName ? `From ${d.clientName}. ` : ""}Check it matches your terminal. Expires{" "}
          {new Date(d.expiresAt).toLocaleTimeString()}.
        </div>
      </div>
      <div className="grid gap-2">
        <Label>What this token may do</Label>
        <RadioGroup value={scope} onValueChange={(v) => setScope(v as Scope)}>
          <label className="flex items-start gap-2 text-sm" htmlFor="scope-read">
            <RadioGroupItem id="scope-read" value="read" className="mt-0.5" />
            <span>
              <span className="font-medium">Read only</span>
              <span className="block text-muted-foreground">
                See the inbox, work items, runs and the merge queue. Choose this for an agent
                session.
              </span>
            </span>
          </label>
          <label className="flex items-start gap-2 text-sm" htmlFor="scope-write">
            <RadioGroupItem id="scope-write" value="write" className="mt-0.5" />
            <span>
              <span className="font-medium">Read and write</span>
              <span className="block text-muted-foreground">
                Also create work, attach PRs and cancel items, as you.
              </span>
            </span>
          </label>
        </RadioGroup>
        <p className="text-muted-foreground text-xs">
          Neither can approve a spec or a merge, answer questions or turn a kill switch off: those
          stay in this app.
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy} onClick={() => decide(true)} data-testid="approve-cli-device">
          Approve
        </Button>
        <Button variant="ghost" disabled={busy} onClick={() => decide(false)}>
          Deny
        </Button>
      </div>
    </Card>
  );
}

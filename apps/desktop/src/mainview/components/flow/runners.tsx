// Team › Runners: the machines that run your agents. The list (`runner.list`), a runner's detail
// (`?runner=`) with its Claude accounts and a way to switch (`runner.account.use`), and Connect a
// runner: the command to run on the other Mac, then the code it prints, looked up
// (`runner.deviceLookup`) and approved with Touch ID (`runner.approveDevice` through decide) or
// turned down (`runner.denyDevice`).
import type { OpOutput } from "@software-factory/client/ops";
import { Button } from "@software-factory/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@software-factory/ui/components/dialog";
import { Input } from "@software-factory/ui/components/input";
import { Label } from "@software-factory/ui/components/label";
import { Skeleton } from "@software-factory/ui/components/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@software-factory/ui/components/table";
import { cn } from "@software-factory/ui/lib/utils";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { CopyIcon, PlusIcon, XIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { decide, OpError, op, read, submitKey } from "../../lib/op.ts";
import { runnersQuery } from "../../lib/queries.ts";
import {
  loginCode,
  RUNNER_LOGIN_COMMAND,
  type RunnerRow,
  runnerAccounts,
  runnerRows,
} from "../../lib/team.ts";
import { Pill } from "./parts.tsx";

type Listed = OpOutput<"runner.list">["runners"][number];
type Lookup = OpOutput<"runner.deviceLookup">;

const message = (err: unknown) =>
  err instanceof OpError || err instanceof Error ? err.message : String(err);

export function Runners({
  orgId,
  runnerId,
  onConnect,
}: {
  orgId: string;
  runnerId: string | undefined;
  onConnect: () => void;
}) {
  const listed = useQuery(runnersQuery());
  if (listed.error)
    return <p className="p-6 text-bad">Couldn't load the runners. {listed.error.message}</p>;
  if (!listed.data) return <Skeleton className="m-4 h-40" />;
  const rows = runnerRows(listed.data.runners);
  const chosen = listed.data.runners.find((r) => r.id === runnerId);
  const chosenRow = rows.find((r) => r.id === runnerId);
  const thisMac = (
    <p className="text-[12.5px] text-ink-muted" data-testid="this-mac-note">
      This Mac's own runner is set up and controlled in{" "}
      <Link
        to="/flow/$orgId/settings"
        params={{ orgId }}
        className="text-ink underline underline-offset-2"
      >
        Settings › This Mac
      </Link>
      .
    </p>
  );
  return (
    <div className="grid gap-3 p-4" data-testid="runners">
      {rows.length === 0 ? (
        <>
          <div
            className="grid justify-items-start gap-3 rounded-[10px] border border-line bg-panel px-4 py-4"
            data-testid="runners-empty"
          >
            <p className="text-ink-muted">
              No runners yet: connect a Mac and your agents run on it.
            </p>
            <Button size="md" onClick={onConnect} data-testid="connect-runner-empty">
              <PlusIcon />
              Connect a runner
            </Button>
          </div>
          {thisMac}
        </>
      ) : (
        <div className="flex min-w-0 items-start gap-4">
          <div className="grid min-w-0 flex-1 gap-3">
            <RunnerTable orgId={orgId} rows={rows} chosenId={chosen?.id} />
            {thisMac}
          </div>
          {chosen && chosenRow && (
            <RunnerDetail key={chosen.id} orgId={orgId} runner={chosen} row={chosenRow} />
          )}
        </div>
      )}
    </div>
  );
}

function RunnerTable({
  orgId,
  rows,
  chosenId,
}: {
  orgId: string;
  rows: RunnerRow[];
  chosenId: string | undefined;
}) {
  const navigate = useNavigate();
  const open = (id: string) =>
    void navigate({
      to: "/flow/$orgId/team",
      params: { orgId },
      search: { tab: "runners", runner: id },
    });
  return (
    <div className="min-w-0 flex-1 overflow-hidden rounded-[10px] border border-line bg-panel">
      <Table className="text-[13px]">
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="text-[11.5px] text-ink-faint">Runner</TableHead>
            <TableHead className="text-[11.5px] text-ink-faint">Seen</TableHead>
            <TableHead className="text-[11.5px] text-ink-faint">Working on</TableHead>
            <TableHead className="text-[11.5px] text-ink-faint">New work</TableHead>
            <TableHead className="text-[11.5px] text-ink-faint">Code</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow
              key={r.id}
              className={cn("cursor-pointer", r.id === chosenId && "bg-picked hover:bg-picked")}
              aria-selected={r.id === chosenId}
              onClick={() => open(r.id)}
              data-testid="runner-row"
            >
              <TableCell className="font-medium">
                <Link
                  to="/flow/$orgId/team"
                  params={{ orgId }}
                  search={{ tab: "runners", runner: r.id }}
                  onClick={(e) => e.stopPropagation()}
                  data-testid="runner-open"
                >
                  {r.name}
                </Link>
              </TableCell>
              <TableCell>
                <Seen row={r} />
              </TableCell>
              <TableCell>{working(r)}</TableCell>
              <TableCell className={cn(!r.takesWork.yes && "text-ink-muted")}>
                {newWork(r)}
              </TableCell>
              <TableCell className={cn(!r.code.current && "text-need")}>{r.code.text}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

const working = (r: RunnerRow) =>
  r.working === 0 ? "Nothing" : `${r.working} job${r.working === 1 ? "" : "s"}`;
const newWork = (r: RunnerRow) =>
  r.takesWork.yes ? "Takes new work" : `Not now: ${r.takesWork.why}`;

function Seen({ row }: { row: RunnerRow }) {
  return (
    <span className="flex items-center gap-1.5">
      <span
        aria-hidden
        className={cn("size-2 flex-none rounded-full", row.online ? "bg-ok" : "bg-line-strong")}
      />
      {row.seen}
    </span>
  );
}

/** One runner: how it is, and its Claude accounts with a way to switch. */
function RunnerDetail({ orgId, runner, row }: { orgId: string; runner: Listed; row: RunnerRow }) {
  const client = useQueryClient();
  const [saving, setSaving] = useState<string | null>(null);
  const accounts = runnerAccounts(runner);
  const switching = accounts?.some((a) => a.switching) ?? false;

  async function use(name: string) {
    setSaving(name);
    try {
      await op(
        "runner.account.use",
        { runnerId: runner.id, name },
        { idempotencyKey: submitKey() },
      );
      await client.invalidateQueries({ queryKey: ["runners"] });
    } catch (err) {
      toast.error("Couldn't switch the Claude account", { description: message(err) });
    } finally {
      setSaving(null);
    }
  }

  return (
    <aside
      className="grid w-[320px] flex-none gap-2.5 rounded-[10px] border border-line bg-panel px-4 py-3.5"
      data-testid="runner-detail"
    >
      <div className="flex items-center gap-2">
        <h2 className="min-w-0 flex-1 truncate font-semibold text-[16px]" data-testid="runner-name">
          {runner.name}
        </h2>
        <Button asChild size="icon-md" variant="ghost" aria-label="Close">
          <Link to="/flow/$orgId/team" params={{ orgId }} search={{ tab: "runners" }}>
            <XIcon />
          </Link>
        </Button>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[13px]">
        <dt className="text-ink-muted">Seen</dt>
        <dd>
          <Seen row={row} />
        </dd>
        <dt className="text-ink-muted">Working on</dt>
        <dd>{working(row)}</dd>
        <dt className="text-ink-muted">New work</dt>
        <dd className={cn(!row.takesWork.yes && "text-ink-muted")}>{newWork(row)}</dd>
        <dt className="text-ink-muted">Code</dt>
        <dd className={cn(!row.code.current && "text-need")}>{row.code.text}</dd>
      </dl>
      <div className="mt-1 font-medium text-[11.5px] text-ink-faint">Claude accounts</div>
      {accounts === null ? (
        <p className="text-[12.5px] text-ink-muted" data-testid="runner-accounts-unknown">
          It hasn't said which Claude accounts it has yet. It will once it has checked in with its
          code up to date.
        </p>
      ) : (
        <ul className="grid" data-testid="runner-accounts">
          {accounts.map((a) => (
            <li
              key={a.name}
              className="flex min-w-0 items-center gap-2 border-line-soft border-b py-1.5 last:border-b-0"
              data-testid="runner-account"
            >
              <span className="grid min-w-0 flex-1">
                <span className="truncate font-medium">{a.name}</span>
                {a.name === "default" && (
                  <span className="text-[11.5px] text-ink-muted">
                    Whoever Claude is signed in as there
                  </span>
                )}
                {a.limit && (
                  <span className="truncate text-[11.5px] text-bad" title={a.limit}>
                    {a.limit}
                  </span>
                )}
              </span>
              {a.active ? (
                <Pill className="text-ok" data-testid="account-in-use">
                  In use
                </Pill>
              ) : a.switching ? (
                <Pill>Switching…</Pill>
              ) : (
                <Button
                  size="md"
                  variant="outline"
                  disabled={saving !== null || switching}
                  onClick={() => void use(a.name)}
                  data-testid="use-account"
                >
                  Use
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      <p className="text-[12px] text-ink-muted leading-snug">
        New work uses the account in use; work already running keeps its own. Add an account on that
        Mac with <code className="font-mono">sf-runner account add</code>.
      </p>
    </aside>
  );
}

type Step =
  | { kind: "code" }
  | { kind: "confirm"; lookup: Lookup }
  | { kind: "done"; connected: boolean; name: string };

/**
 * Connect a runner: the command for the other Mac, the code it prints, then who is asking, with
 * Connect (Touch ID) and Don't connect.
 */
export function ConnectRunnerDialog({
  open,
  onOpenChange,
  onConnected,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConnected: (runnerId: string) => void;
}) {
  const client = useQueryClient();
  const [step, setStep] = useState<Step>({ kind: "code" });
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function change(next: boolean) {
    if (!next) {
      setStep({ kind: "code" });
      setCode("");
      setName("");
      setError(null);
    }
    onOpenChange(next);
  }

  async function look(e: React.FormEvent) {
    e.preventDefault();
    const userCode = loginCode(code);
    if (!userCode) {
      setError("A code is eight letters and digits, like BCDF-GHJK.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const lookup = await read("runner.deviceLookup", { userCode });
      setName(lookup.suggestedName ?? "");
      setStep({ kind: "confirm", lookup });
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  async function connect(userCode: string) {
    setBusy(true);
    setError(null);
    try {
      const made = await decide(
        "runner.approveDevice",
        { userCode, name: name.trim() },
        { idempotencyKey: submitKey() },
      );
      await client.invalidateQueries({ queryKey: ["runners"] });
      setStep({ kind: "done", connected: true, name: made.name });
      onConnected(made.runnerId);
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  async function turnDown(userCode: string) {
    setBusy(true);
    setError(null);
    try {
      await op("runner.denyDevice", { userCode }, { idempotencyKey: submitKey() });
      setStep({ kind: "done", connected: false, name: "" });
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={change}>
      <DialogContent className="sm:max-w-xl" data-testid="connect-dialog">
        <DialogHeader>
          <DialogTitle>Connect a runner</DialogTitle>
          {step.kind === "code" && (
            <DialogDescription>
              A runner is a Mac that runs your agents with Claude Code.
            </DialogDescription>
          )}
        </DialogHeader>
        {step.kind === "code" && (
          <form onSubmit={look} className="grid gap-4" data-testid="connect-code-step">
            <div className="grid gap-1.5">
              <div className="font-medium">1. On the other Mac, run this in Terminal</div>
              <div className="flex items-start gap-2">
                <pre
                  className="min-w-0 flex-1 whitespace-pre-wrap break-words rounded-md bg-field px-2.5 py-2 font-mono text-[11.5px]"
                  data-testid="login-command"
                >
                  {RUNNER_LOGIN_COMMAND}
                </pre>
                <Button
                  type="button"
                  size="md"
                  variant="outline"
                  onClick={() => void copy(RUNNER_LOGIN_COMMAND)}
                  data-testid="copy-command"
                >
                  <CopyIcon />
                  Copy
                </Button>
              </div>
              <p className="text-[12px] text-ink-muted leading-snug">
                That Mac needs git, Node 24 with pnpm, tmux, and Claude Code signed in. Once you
                connect it here, it keeps running there in the background.
              </p>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="runner-code">2. Type the code it prints</Label>
              <Input
                id="runner-code"
                className="w-44 font-mono uppercase"
                placeholder="XXXX-XXXX"
                autoFocus
                autoComplete="off"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                data-testid="runner-code"
              />
            </div>
            {error && (
              <p className="text-bad" data-testid="connect-error">
                {error}
              </p>
            )}
            <DialogFooter>
              <Button type="submit" disabled={busy || !code.trim()} data-testid="look-up-code">
                Continue
              </Button>
            </DialogFooter>
          </form>
        )}
        {step.kind === "confirm" && (
          <Confirm
            lookup={step.lookup}
            name={name}
            onName={setName}
            busy={busy}
            error={error}
            onConnect={() => void connect(step.lookup.userCode)}
            onTurnDown={() => void turnDown(step.lookup.userCode)}
            onBack={() => {
              setError(null);
              setStep({ kind: "code" });
            }}
          />
        )}
        {step.kind === "done" && (
          <div className="grid gap-4" data-testid={step.connected ? "connected" : "turned-down"}>
            <p>
              {step.connected ? (
                <>
                  <span className="font-medium">{step.name}</span> is connected. That Mac finishes
                  on its own: it saves its key and starts the runner, and shows as online here
                  within a minute.
                </>
              ) : (
                "Not connected. The login on that Mac stops."
              )}
            </p>
            <DialogFooter>
              <Button onClick={() => change(false)} data-testid="connect-close">
                Done
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Confirm({
  lookup,
  name,
  onName,
  busy,
  error,
  onConnect,
  onTurnDown,
  onBack,
}: {
  lookup: Lookup;
  name: string;
  onName: (name: string) => void;
  busy: boolean;
  error: string | null;
  onConnect: () => void;
  onTurnDown: () => void;
  onBack: () => void;
}) {
  if (lookup.status !== "pending") {
    const why =
      lookup.status === "expired"
        ? "This code has expired. Run the command on that Mac again for a new one."
        : lookup.decidedByYou
          ? `You already ${lookup.status === "denied" ? "turned this code down" : "connected this runner"}.`
          : "This code was already used. Run the command on that Mac again for a new one.";
    return (
      <div className="grid gap-4" data-testid="connect-code-used">
        <p>{why}</p>
        <DialogFooter>
          <Button variant="outline" onClick={onBack}>
            Enter another code
          </Button>
        </DialogFooter>
      </div>
    );
  }
  const expires = new Date(lookup.expiresAt).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
  return (
    <div className="grid gap-4" data-testid="connect-confirm-step">
      <div className="grid gap-1 rounded-md border border-line px-3.5 py-3">
        <div className="text-[12px] text-ink-muted">Asking to connect</div>
        <div className="font-semibold text-[15px]" data-testid="asking-name">
          {lookup.suggestedName ?? "A Mac that didn't give its name"}
        </div>
        <div className="text-[12.5px] text-ink-muted">
          Code <span className="font-mono text-ink">{lookup.userCode}</span>: check it matches that
          Mac's Terminal. It expires at {expires}.
        </div>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="runner-new-name">Call it</Label>
        <Input
          id="runner-new-name"
          value={name}
          maxLength={80}
          onChange={(e) => onName(e.target.value)}
          data-testid="runner-new-name"
        />
      </div>
      <p className="text-[12px] text-ink-muted">
        Only connect a Mac you just ran the command on. It will run your agents with its own Claude
        login. Connecting asks for Touch ID.
      </p>
      {error && (
        <p className="text-bad" data-testid="connect-error">
          {error}
        </p>
      )}
      <DialogFooter>
        <Button variant="ghost" disabled={busy} onClick={onTurnDown} data-testid="dont-connect">
          Don't connect
        </Button>
        <Button disabled={busy || !name.trim()} onClick={onConnect} data-testid="connect">
          Connect
        </Button>
      </DialogFooter>
    </div>
  );
}

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success("Command copied");
  } catch {
    toast.error("Couldn't copy the command");
  }
}

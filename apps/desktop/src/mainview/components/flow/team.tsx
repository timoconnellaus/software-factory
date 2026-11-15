// Team (.kim/mockups/team-an-agent.html): Agents, Runners and People as tabs across the top.
// Agents: the org's agents on the left with what each is doing now; the chosen one's page with its
// instructions (edited in place), what it is working on and its recent runs; and its properties
// with Tools, where one switch gives it the Plugin editor (its `mcp` is `["factory"]`).
import { type FlowAgent, flowKey, hasPluginEditor, when } from "@software-factory/client/flow";
import { Button } from "@software-factory/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@software-factory/ui/components/dialog";
import { Input } from "@software-factory/ui/components/input";
import { Label } from "@software-factory/ui/components/label";
import { Skeleton } from "@software-factory/ui/components/skeleton";
import { Switch } from "@software-factory/ui/components/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@software-factory/ui/components/table";
import { Textarea } from "@software-factory/ui/components/textarea";
import { cn } from "@software-factory/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { CircleCheckIcon, CircleXIcon, LoaderIcon, PlusIcon, PuzzleIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  flowAgentRunsQuery,
  flowAgentsQuery,
  flowInboxAllQuery,
  useFlowRefresh,
} from "../../lib/flow-queries.ts";
import { OpError, op, submitKey } from "../../lib/op.ts";
import { runnerHealthQuery, runnersQuery } from "../../lib/queries.ts";
import { agentUpdate, agentWorking, duration, runnerRows, runOutcome } from "../../lib/team.ts";
import { MembersList } from "./members.tsx";
import { PageHeader, Pill } from "./parts.tsx";

export type TeamTab = "agents" | "runners" | "people";
const TABS: { id: TeamTab; label: string }[] = [
  { id: "agents", label: "Agents" },
  { id: "runners", label: "Runners" },
  { id: "people", label: "People" },
];

export function TeamPage({
  orgId,
  tab,
  agentId,
}: {
  orgId: string;
  tab: TeamTab;
  agentId: string | undefined;
}) {
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const go = (search: { tab?: Exclude<TeamTab, "agents">; agent?: string }) =>
    void navigate({ to: "/flow/$orgId/team", params: { orgId }, search });
  return (
    <main className="flex min-w-0 flex-1 flex-col" data-testid="team-page">
      <PageHeader
        title="Team"
        tabs={TABS.map((t) => t.label)}
        tab={TABS.find((t) => t.id === tab)?.label}
        onTab={(label) => {
          const id = TABS.find((t) => t.label === label)?.id;
          go(id === "runners" || id === "people" ? { tab: id } : {});
        }}
      >
        <span className="flex-1" />
        {tab === "agents" && (
          <Button size="md" onClick={() => setCreating(true)} data-testid="new-agent">
            <PlusIcon />
            New agent
          </Button>
        )}
      </PageHeader>
      <div className="min-h-0 flex-1 overflow-auto bg-board">
        {tab === "agents" && <Agents orgId={orgId} agentId={agentId} />}
        {tab === "runners" && <Runners orgId={orgId} />}
        {tab === "people" && (
          <div className="p-5">
            <MembersList orgId={orgId} />
          </div>
        )}
      </div>
      <NewAgentDialog
        orgId={orgId}
        open={creating}
        onOpenChange={setCreating}
        onCreated={(id) => go({ agent: id })}
      />
    </main>
  );
}

// ---- Agents -------------------------------------------------------------------------------------

function Agents({ orgId, agentId }: { orgId: string; agentId: string | undefined }) {
  const agents = useQuery(flowAgentsQuery(orgId));
  const all = useQuery(flowInboxAllQuery());
  if (agents.error)
    return <p className="p-6 text-bad">Couldn't load the agents. {agents.error.message}</p>;
  if (!agents.data)
    return (
      <div className="flex gap-4 p-4">
        <Skeleton className="h-60 w-[250px]" />
        <Skeleton className="h-60 flex-1" />
      </div>
    );
  const list = agents.data.agents;
  if (list.length === 0)
    return (
      <p className="p-6 text-ink-muted" data-testid="agents-empty">
        No agents yet. Make one with New agent.
      </p>
    );
  const chosen = list.find((a) => a.id === agentId) ?? list[0];
  // What each agent is doing now, when the server can say (`flow.inbox.all`).
  const known = !!all.data && all.data.orgs.length > 0;
  return (
    <div className="flex min-h-full items-start gap-4 p-4">
      <nav
        aria-label="Agents"
        className="grid w-[250px] flex-none gap-0.5 rounded-[10px] border border-line bg-panel p-1.5"
        data-testid="agent-list"
      >
        {list.map((a) => {
          const now = agentWorking(all.data, orgId, a.id)[0];
          const on = a.id === chosen?.id;
          return (
            <Link
              key={a.id}
              to="/flow/$orgId/team"
              params={{ orgId }}
              search={{ agent: a.id }}
              aria-current={on ? "page" : undefined}
              className={cn(
                "flex items-center gap-2.5 rounded-[7px] px-2 py-1.5 hover:bg-hover",
                on && "bg-picked hover:bg-picked",
              )}
              data-testid="agent-row"
            >
              <AgentMark name={a.name} />
              <span className="grid min-w-0">
                <span className="truncate font-medium">{a.name}</span>
                {known && (
                  <span className="truncate text-[11.5px] text-ink-muted">
                    {now ? `Working · ${now.projectKey}-${now.number}` : "Idle"}
                  </span>
                )}
              </span>
            </Link>
          );
        })}
      </nav>
      {chosen && <AgentPage key={chosen.id} orgId={orgId} agent={chosen} />}
    </div>
  );
}

function AgentMark({ name, size = "sm" }: { name: string; size?: "sm" | "lg" }) {
  return (
    <span
      aria-hidden
      className={cn(
        "grid flex-none place-items-center rounded-[7px] border border-line bg-window font-semibold text-ink",
        size === "sm" ? "size-7 text-[11.5px]" : "size-9 text-[14px]",
      )}
    >
      {(name.trim()[0] ?? "?").toUpperCase()}
    </span>
  );
}

function AgentPage({ orgId, agent }: { orgId: string; agent: FlowAgent }) {
  const refresh = useFlowRefresh(orgId);
  const all = useQuery(flowInboxAllQuery());
  const runs = useQuery(flowAgentRunsQuery(orgId, agent.id));
  const [instructions, setInstructions] = useState(agent.instructions);
  const [saving, setSaving] = useState(false);
  const [editor, setEditor] = useState(hasPluginEditor(agent));
  useEffect(() => setEditor(hasPluginEditor(agent)), [agent]);
  const dirty = instructions !== agent.instructions;
  const working = agentWorking(all.data, orgId, agent.id);
  const recent = (runs.data?.runs ?? []).filter((r) => runOutcome(r).text !== "Running");

  async function save(change: Parameters<typeof agentUpdate>[2], failed: string) {
    setSaving(true);
    try {
      await op("flow.agent.update", agentUpdate(orgId, agent, change), {
        idempotencyKey: submitKey(),
      });
      await refresh();
      return true;
    } catch (err) {
      toast.error(failed, {
        description: err instanceof OpError || err instanceof Error ? err.message : String(err),
      });
      return false;
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <section
        className="grid min-w-0 flex-1 gap-3 rounded-[10px] border border-line bg-panel px-5 py-4"
        data-testid="agent-page"
      >
        <div className="flex items-center gap-3">
          <AgentMark name={agent.name} size="lg" />
          <h2 className="font-semibold text-[18px]" data-testid="agent-name">
            {agent.name}
          </h2>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="agent-instructions" className="text-[12px] text-ink-muted">
            Instructions
          </Label>
          <Textarea
            id="agent-instructions"
            value={instructions}
            rows={6}
            maxLength={20_000}
            placeholder="What this agent does, and how."
            onChange={(e) => setInstructions(e.target.value)}
            data-testid="agent-instructions"
          />
          {dirty && (
            <div className="flex gap-2">
              <Button
                size="md"
                disabled={saving}
                onClick={() => void save({ instructions }, "Couldn't save the instructions")}
                data-testid="save-instructions"
              >
                Save
              </Button>
              <Button
                size="md"
                variant="ghost"
                disabled={saving}
                onClick={() => setInstructions(agent.instructions)}
              >
                Cancel
              </Button>
            </div>
          )}
        </div>
        {working.length > 0 && (
          <>
            <SectionTitle>Now</SectionTitle>
            {working.map((i) => (
              <Line key={i.id} data-testid="agent-now">
                <Pill className="border-transparent bg-work-soft text-work">Running</Pill>
                <span className="text-ink-muted">{flowKey({ key: i.projectKey }, i.number)}</span>
                <span className="truncate">{i.title}</span>
                <Button asChild size="md" variant="outline" className="ml-auto">
                  <Link
                    to="/flow/$orgId/p/$projectId"
                    params={{ orgId, projectId: i.projectId }}
                    search={{ item: i.id }}
                  >
                    Open
                  </Link>
                </Button>
              </Line>
            ))}
          </>
        )}
        {/* Recent work only when the server lists an agent's runs; never made up. */}
        {runs.data && (
          <>
            <SectionTitle>Recent work</SectionTitle>
            {recent.length === 0 ? (
              <p className="text-ink-muted">No runs yet.</p>
            ) : (
              recent.slice(0, 10).map((r, n) => {
                const out = runOutcome(r);
                const took = duration(r.claimedAt, r.finishedAt);
                return (
                  <Line key={r.id ?? `${r.itemId}-${n}`} data-testid="agent-run">
                    {out.ok === false ? (
                      <CircleXIcon className="size-4 flex-none text-bad" />
                    ) : out.ok ? (
                      <CircleCheckIcon className="size-4 flex-none text-ok" />
                    ) : (
                      <LoaderIcon className="size-4 flex-none text-ink-muted" />
                    )}
                    <span className="truncate">{r.itemTitle ?? "An item"}</span>
                    <span className="ml-auto flex-none text-[12px] text-ink-muted">
                      <span className={cn(out.ok === false && "text-bad")}>{out.text}</span>
                      {r.finishedAt && ` · ${when(r.finishedAt)}`}
                      {took && ` · ${took}`}
                    </span>
                  </Line>
                );
              })
            )}
          </>
        )}
      </section>
      <aside
        className="grid w-[270px] flex-none gap-2 rounded-[10px] border border-line bg-panel px-4 py-4"
        data-testid="agent-properties"
      >
        <SectionTitle first>Tools</SectionTitle>
        <div className="flex items-start gap-3">
          <Label htmlFor="plugin-editor" className="grid flex-1 gap-0.5 font-normal">
            <span className="flex items-center gap-1.5 font-medium">
              <PuzzleIcon className="size-3.5 text-ink-muted" />
              Plugin editor
            </span>
            <span className="text-[12px] text-ink-muted leading-snug">
              Lets this agent set up workflows and build plugins.
            </span>
          </Label>
          <Switch
            id="plugin-editor"
            checked={editor}
            disabled={saving}
            onCheckedChange={async (on) => {
              setEditor(on);
              const ok = await save(
                { pluginEditor: on },
                on ? "Couldn't turn on the Plugin editor" : "Couldn't turn off the Plugin editor",
              );
              if (!ok) setEditor(!on);
            }}
            data-testid="plugin-editor"
          />
        </div>
      </aside>
    </>
  );
}

function SectionTitle({ children, first }: { children: React.ReactNode; first?: boolean }) {
  return (
    <div className={cn("font-medium text-[11.5px] text-ink-faint", !first && "mt-2")}>
      {children}
    </div>
  );
}

function Line({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex min-w-0 items-center gap-2.5 border-line-soft border-b py-1.5 last:border-b-0",
        className,
      )}
      {...props}
    />
  );
}

function NewAgentDialog({
  orgId,
  open,
  onOpenChange,
  onCreated,
}: {
  orgId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (agentId: string) => void;
}) {
  const refresh = useFlowRefresh(orgId);
  const [name, setName] = useState("");
  const [instructions, setInstructions] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const agent = await op(
        "flow.agent.create",
        { orgId, name: name.trim(), instructions },
        { idempotencyKey: submitKey() },
      );
      await refresh();
      onOpenChange(false);
      setName("");
      setInstructions("");
      onCreated(agent.id);
    } catch (err) {
      setError(err instanceof OpError || err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={create} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>New agent</DialogTitle>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor="agent-name">Name</Label>
            <Input
              id="agent-name"
              value={name}
              autoFocus
              maxLength={80}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="new-agent-instructions">Instructions</Label>
            <Textarea
              id="new-agent-instructions"
              value={instructions}
              rows={5}
              maxLength={20_000}
              onChange={(e) => setInstructions(e.target.value)}
            />
          </div>
          {error && <p className="text-bad">{error}</p>}
          <DialogFooter>
            <Button type="submit" disabled={saving || !name.trim()} data-testid="create-agent">
              Create agent
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---- Runners ------------------------------------------------------------------------------------

function Runners({ orgId }: { orgId: string }) {
  const listed = useQuery(runnersQuery());
  const health = useQuery(runnerHealthQuery());
  if (listed.error)
    return <p className="p-6 text-bad">Couldn't load the runners. {listed.error.message}</p>;
  if (!listed.data) return <Skeleton className="m-4 h-40" />;
  const rows = runnerRows(listed.data.runners, health.data ?? []);
  return (
    <div className="grid gap-3 p-4" data-testid="runners">
      {rows.length === 0 ? (
        <p className="text-ink-muted">No runners yet.</p>
      ) : (
        <div className="overflow-hidden rounded-[10px] border border-line bg-panel">
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
                <TableRow key={r.id} className="cursor-default" data-testid="runner-row">
                  <TableCell className="font-medium">{r.name}</TableCell>
                  <TableCell>
                    <span className="flex items-center gap-1.5">
                      <span
                        aria-hidden
                        className={cn("size-2 rounded-full", r.online ? "bg-ok" : "bg-line-strong")}
                      />
                      {r.seen}
                    </span>
                  </TableCell>
                  <TableCell>
                    {r.working === 0 ? "Nothing" : `${r.working} job${r.working === 1 ? "" : "s"}`}
                  </TableCell>
                  <TableCell className={cn(!r.takesWork.yes && "text-ink-muted")}>
                    {r.takesWork.yes ? "Takes new work" : `Not now: ${r.takesWork.why}`}
                  </TableCell>
                  <TableCell className={cn(!r.code.current && "text-need")}>
                    {r.code.text}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <p className="text-[12.5px] text-ink-muted" data-testid="connect-runner">
        This Mac's runner is set up and controlled in{" "}
        <Link
          to="/flow/$orgId/settings"
          params={{ orgId }}
          className="text-ink underline underline-offset-2"
        >
          Settings › This Mac
        </Link>
        . To add another machine, run <code className="font-mono">sf-runner login</code> on it.
      </p>
    </div>
  );
}

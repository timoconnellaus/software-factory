// The workflow editor (.kim/mockups/workflow-editor.html): a project's Workflow tab, and the same
// editor opened from the Workflows list. The statuses are a row of boxes in order; choosing one opens
// its editor below. Save sends the whole workflow (flow.workflow.update), and a problem the server
// finds shows beside the status it names. Status ids are made from names and never shown. A workflow
// other projects use says so above Save, and can be copied for this project instead.
import type {
  FlowAgent,
  FlowOwner,
  FlowProject,
  FlowStatus,
  FlowWorkflow,
} from "@software-factory/client/flow";
import { personName } from "@software-factory/client/flow";
import {
  asProblems,
  type FlowMember,
  isNewStatus,
  moveStatus,
  newStatus,
  problemsByStatus,
  removeStatus,
  sendsBackTo,
  statusesToSave,
} from "@software-factory/client/flow-edit";
import { Button } from "@software-factory/ui/components/button";
import { Input } from "@software-factory/ui/components/input";
import { Label } from "@software-factory/ui/components/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@software-factory/ui/components/select";
import { Switch } from "@software-factory/ui/components/switch";
import { Textarea } from "@software-factory/ui/components/textarea";
import { cn } from "@software-factory/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  CornerDownLeftIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { flowMembersQuery } from "../../lib/flow-edit-queries.ts";
import {
  flowAgentsQuery,
  flowProjectsQuery,
  flowWorkflowsQuery,
  useFlowRefresh,
  useNames,
} from "../../lib/flow-queries.ts";
import { OpError, op, submitKey } from "../../lib/op.ts";
import { useSession } from "../../lib/session.ts";
import { OwnerMark, PageHeader, Pill, StatusMark } from "./parts.tsx";

const ownerValue = (o: FlowOwner) =>
  o.kind === "agent" ? `agent:${o.agentId}` : o.kind === "person" ? `person:${o.userId}` : "none";

function ownerFrom(value: string): FlowOwner {
  if (value.startsWith("agent:")) return { kind: "agent", agentId: value.slice(6) };
  if (value.startsWith("person:")) return { kind: "person", userId: value.slice(7) };
  return { kind: "none" };
}

/** Who can own a status, and their names: the org's agents and members (else the signed-in person). */
function useOwners(orgId: string) {
  const session = useSession();
  const names = useNames(orgId);
  const agents = useQuery(flowAgentsQuery(orgId));
  const members = useQuery(flowMembersQuery(orgId));
  const people: FlowMember[] = members.data?.members.length
    ? members.data.members
    : [{ userId: session.user.id, name: session.user.name, login: "" }];
  const agentList: FlowAgent[] = agents.data?.agents ?? [];
  const nameOf = (o: FlowOwner): { name: string; kind: "agent" | "person" | "none" } => {
    if (o.kind === "agent")
      return { name: agentList.find((a) => a.id === o.agentId)?.name ?? "An agent", kind: "agent" };
    if (o.kind === "person")
      return {
        name: people.find((p) => p.userId === o.userId)?.name ?? personName(names, o.userId),
        kind: "person",
      };
    return { name: "Nobody", kind: "none" };
  };
  return { agents: agentList, people, nameOf };
}

const message = (e: unknown) =>
  e instanceof OpError || e instanceof Error ? e.message : "Couldn't save the workflow";

export function WorkflowEditor({
  orgId,
  workflow,
  project,
  showName = false,
}: {
  orgId: string;
  workflow: FlowWorkflow;
  /** The project whose Workflow tab this is; none from the Workflows list. */
  project?: FlowProject;
  /** The workflow's own name as a field (the Workflows list); a project's tab leaves it out. */
  showName?: boolean;
}) {
  const owners = useOwners(orgId);
  const projects = useQuery(flowProjectsQuery(orgId));
  const refresh = useFlowRefresh(orgId);
  const [name, setName] = useState(workflow.workflow.name);
  const [statuses, setStatuses] = useState<FlowStatus[]>(workflow.workflow.statuses);
  const [openId, setOpenId] = useState<string | null>(statuses[0]?.id ?? null);
  const [problems, setProblems] = useState<Map<string, string[]>>(new Map());
  const [saving, setSaving] = useState(false);
  const dirty =
    name !== workflow.workflow.name ||
    JSON.stringify(statuses) !== JSON.stringify(workflow.workflow.statuses);
  const using = (projects.data?.projects ?? []).filter((p) => p.workflowId === workflow.id);
  const others = using.filter((p) => p.id !== project?.id);
  const index = statuses.findIndex((s) => s.id === openId);
  const open = statuses[index];

  const change = (next: FlowStatus[]) => {
    setStatuses(next);
  };
  const update = (patch: Partial<FlowStatus>, drop: (keyof FlowStatus)[] = []) => {
    if (!open) return;
    change(
      statuses.map((s) => {
        if (s.id !== open.id) return s;
        const out = { ...s, ...patch };
        for (const k of drop) delete out[k];
        return out;
      }),
    );
  };

  /** Sends the workflow; on a refusal, its problems go beside their statuses. */
  async function send(run: (sent: FlowStatus[]) => Promise<FlowWorkflow | null>) {
    const { statuses: sent, ids } = statusesToSave(statuses);
    setSaving(true);
    try {
      const saved = await run(sent);
      setProblems(new Map());
      if (saved) {
        setStatuses(saved.workflow.statuses);
        setName(saved.workflow.name);
      }
      if (openId) setOpenId(ids.get(openId) ?? openId);
      await refresh();
      return true;
    } catch (error) {
      const found = error instanceof OpError ? asProblems(error.details) : [];
      setProblems(
        found.length ? problemsByStatus(found, sent, statuses) : new Map([["", [message(error)]]]),
      );
      return false;
    } finally {
      setSaving(false);
    }
  }

  const save = () =>
    send((sent) =>
      op(
        "flow.workflow.update",
        { orgId, workflowId: workflow.id, name: name.trim(), statuses: sent },
        { idempotencyKey: submitKey() },
      ),
    ).then((ok) => ok && toast.success("Workflow saved"));

  const copy = () =>
    project &&
    send(async (sent) => {
      const made = await op(
        "flow.workflow.create",
        { orgId, name: `${name.trim()} (${project.name})`.slice(0, 80), statuses: sent },
        { idempotencyKey: submitKey() },
      );
      await op(
        "flow.project.setWorkflow",
        { orgId, projectId: project.id, workflowId: made.id },
        { idempotencyKey: submitKey() },
      );
      return null;
    }).then((ok) => ok && toast.success(`${project.name} has its own copy now`));

  const add = () => {
    const s = newStatus();
    change([...statuses, s]);
    setOpenId(s.id);
  };

  const general = problems.get("");

  return (
    <div className="min-h-0 flex-1 overflow-auto bg-board px-5 py-5" data-testid="workflow-editor">
      {showName && (
        <div className="mb-4 flex max-w-[620px] items-center gap-3">
          <Label htmlFor="workflow-name" className="w-[150px] flex-none text-ink-muted">
            Workflow name
          </Label>
          <Input
            id="workflow-name"
            value={name}
            maxLength={80}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
      )}
      <div className="flex items-start gap-0 overflow-x-auto pb-1" data-testid="status-row">
        {statuses.map((s, i) => {
          const owner = owners.nameOf(s.owner);
          const back = sendsBackTo(statuses, i);
          const bad = problems.has(s.id);
          return (
            <div key={s.id} className="flex flex-none items-start">
              {i > 0 && <ArrowRightIcon className="mx-1.5 mt-10 size-3.5 text-ink-faint" />}
              <div className="flex w-[150px] flex-col items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setOpenId(s.id)}
                  aria-pressed={s.id === openId}
                  className={cn(
                    "flex h-[92px] w-full flex-col items-start gap-1.5 rounded-[10px] border border-line bg-panel px-3 py-2.5 text-left hover:border-line-strong",
                    s.id === openId &&
                      "border-work shadow-[0_0_0_2px_var(--work-soft)] hover:border-work",
                    bad && "border-bad hover:border-bad",
                  )}
                  data-testid="status-box"
                >
                  <span className="flex w-full items-center gap-1.5 font-semibold">
                    <StatusMark index={i} count={statuses.length} />
                    <span className="truncate" data-testid="status-box-name">
                      {s.name || "Untitled"}
                    </span>
                  </span>
                  <span className="flex items-center gap-1.5 text-[12px] text-ink-muted">
                    {owner.kind === "none" ? (
                      <span
                        aria-hidden
                        className="inline-grid size-[17px] place-items-center rounded-[5px] border border-line text-[9px]"
                      >
                        –
                      </span>
                    ) : (
                      <OwnerMark name={owner.name} kind={owner.kind} />
                    )}
                    {owner.name}
                  </span>
                  {s.needsDecision && (
                    <Pill className="border-need-line bg-need-soft text-need">
                      Needs a decision
                    </Pill>
                  )}
                </button>
                {back && (
                  <span
                    className="flex items-center gap-1 text-[11.5px] text-ink-faint"
                    data-testid="sends-back"
                  >
                    <CornerDownLeftIcon className="size-3" />
                    sends back to {back.name}
                  </span>
                )}
                {bad && (
                  <span className="text-center text-[11.5px] text-bad" data-testid="box-problem">
                    Can't save this status
                  </span>
                )}
              </div>
            </div>
          );
        })}
        <button
          type="button"
          onClick={add}
          aria-label="Add a status"
          title="Add a status"
          className="ml-3 grid h-[92px] w-[44px] flex-none place-items-center rounded-[10px] border border-line-strong border-dashed text-ink-faint hover:bg-hover hover:text-ink"
          data-testid="add-status"
        >
          <PlusIcon className="size-4" />
        </button>
      </div>

      <div className="mt-5 max-w-[620px]">
        {open && (
          <StatusEditor
            key={open.id}
            status={open}
            index={index}
            statuses={statuses}
            owners={owners}
            problems={problems.get(open.id) ?? []}
            onChange={update}
            onMove={(by) => change(moveStatus(statuses, index, by))}
            onRemove={() => {
              const next = removeStatus(statuses, index);
              change(next);
              setOpenId(next[Math.min(index, next.length - 1)]?.id ?? null);
            }}
          />
        )}
        <div className="mt-4 grid gap-2.5" data-testid="save-bar">
          {general?.map((m) => (
            <p key={m} className="text-bad" data-testid="workflow-problem">
              {m}
            </p>
          ))}
          {project && others.length > 0 && (
            <div
              className="flex flex-wrap items-center gap-2 rounded-[10px] border border-need-line bg-need-soft px-3 py-2 text-need-ink"
              data-testid="also-changes"
            >
              <span>Also changes: {others.map((p) => p.name).join(", ")}</span>
              <Button
                size="xs"
                variant="outline"
                className="ml-auto"
                disabled={saving}
                onClick={() => void copy()}
                data-testid="copy-workflow"
              >
                Make a copy for this project
              </Button>
            </div>
          )}
          {!project && using.length > 1 && (
            <p className="text-ink-muted" data-testid="also-changes">
              Used by {using.map((p) => p.name).join(", ")}.
            </p>
          )}
          <div className="flex items-center gap-3">
            <Button
              size="md"
              disabled={saving || !dirty}
              onClick={() => void save()}
              data-testid="save-workflow"
            >
              Save
            </Button>
            <span className="text-[12.5px] text-ink-muted">
              {dirty
                ? "Changes apply to items that enter a status from now on."
                : "No changes to save."}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

const NEXT = "__next";
const PREV = "__prev";

function StatusEditor({
  status,
  index,
  statuses,
  owners,
  problems,
  onChange,
  onMove,
  onRemove,
}: {
  status: FlowStatus;
  index: number;
  statuses: FlowStatus[];
  owners: ReturnType<typeof useOwners>;
  problems: string[];
  onChange: (patch: Partial<FlowStatus>, drop?: (keyof FlowStatus)[]) => void;
  onMove: (by: -1 | 1) => void;
  onRemove: () => void;
}) {
  const elsewhere = statuses.filter((s) => s.id !== status.id);
  const owner = status.owner;
  // A person the members list doesn't have still shows as the owner.
  const strayPerson =
    owner.kind === "person" && !owners.people.some((p) => p.userId === owner.userId)
      ? owner.userId
      : null;
  const row = "grid grid-cols-[170px_1fr] items-center gap-3";
  const label = "font-normal text-ink-muted";
  return (
    <section
      className="rounded-xl border border-line bg-panel px-[18px] py-4"
      data-testid="status-editor"
    >
      <div className="mb-3.5 flex items-center gap-2 font-semibold text-[14px]">
        <StatusMark index={index} count={statuses.length} />
        {status.name || "Untitled"}
        {isNewStatus(status.id) && <Pill>New</Pill>}
      </div>
      <div className="grid gap-2.5">
        <div className={row}>
          <Label htmlFor="status-name" className={label}>
            Name
          </Label>
          <Input
            id="status-name"
            value={status.name}
            maxLength={80}
            onChange={(e) => onChange({ name: e.target.value })}
          />
        </div>
        <div className={row}>
          <Label className={label}>On entering, hand to</Label>
          <Select
            value={ownerValue(owner)}
            onValueChange={(v) => onChange({ owner: ownerFrom(v) })}
          >
            <SelectTrigger className="w-full" data-testid="status-owner">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">Nobody</SelectItem>
              {owners.agents.length > 0 && (
                <SelectGroup>
                  <SelectLabel>Agents</SelectLabel>
                  {owners.agents.map((a) => (
                    <SelectItem key={a.id} value={`agent:${a.id}`}>
                      {a.name}
                    </SelectItem>
                  ))}
                </SelectGroup>
              )}
              <SelectGroup>
                <SelectLabel>People</SelectLabel>
                {owners.people.map((p) => (
                  <SelectItem key={p.userId} value={`person:${p.userId}`}>
                    {p.name}
                  </SelectItem>
                ))}
                {strayPerson && (
                  <SelectItem value={`person:${strayPerson}`}>
                    {owners.nameOf(owner).name}
                  </SelectItem>
                )}
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>
        {owner.kind === "agent" && (
          <div className="grid grid-cols-[170px_1fr] items-start gap-3">
            <Label htmlFor="status-brief" className={cn(label, "pt-2")}>
              Brief
            </Label>
            <Textarea
              id="status-brief"
              value={status.brief ?? ""}
              rows={3}
              maxLength={8000}
              placeholder={`What ${owners.nameOf(owner).name} should do here`}
              onChange={(e) => onChange({ brief: e.target.value })}
            />
          </div>
        )}
        <div className={row}>
          <Label className={label}>When done, move to</Label>
          <Select
            value={status.onDone ?? NEXT}
            onValueChange={(v) => (v === NEXT ? onChange({}, ["onDone"]) : onChange({ onDone: v }))}
          >
            <SelectTrigger className="w-full" data-testid="status-on-done">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NEXT}>The next status</SelectItem>
              {elsewhere.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.name || "Untitled"}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className={row}>
          <Label className={label}>If rejected, send back to</Label>
          <Select
            value={status.onReject ?? PREV}
            onValueChange={(v) =>
              v === PREV ? onChange({}, ["onReject"]) : onChange({ onReject: v })
            }
          >
            <SelectTrigger className="w-full" data-testid="status-on-reject">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={PREV}>The status before</SelectItem>
              {elsewhere.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.name || "Untitled"}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className={row}>
          <Label htmlFor="status-decision" className={label}>
            Needs a person's decision
          </Label>
          <Switch
            id="status-decision"
            checked={!!status.needsDecision}
            onCheckedChange={(on) => onChange({ needsDecision: on })}
            data-testid="status-needs-decision"
          />
        </div>
        {problems.map((m) => (
          <p key={m} className="text-bad" data-testid="status-problem">
            {m}
          </p>
        ))}
        <div className="mt-1 flex items-center gap-1.5 border-line-soft border-t pt-3">
          <Button
            size="md"
            variant="ghost"
            disabled={index === 0}
            onClick={() => onMove(-1)}
            data-testid="move-left"
          >
            <ArrowLeftIcon />
            Move left
          </Button>
          <Button
            size="md"
            variant="ghost"
            disabled={index === statuses.length - 1}
            onClick={() => onMove(1)}
            data-testid="move-right"
          >
            Move right
            <ArrowRightIcon />
          </Button>
          <Button
            size="md"
            variant="ghost"
            className="ml-auto text-bad hover:text-bad"
            disabled={statuses.length <= 1}
            onClick={onRemove}
            data-testid="remove-status"
          >
            <Trash2Icon />
            Remove
          </Button>
        </div>
      </div>
    </section>
  );
}

/** A new workflow's first statuses. */
const STARTER: FlowStatus[] = [
  { id: "to-do", name: "To do", owner: { kind: "none" } },
  { id: "doing", name: "Doing", owner: { kind: "none" } },
  { id: "done", name: "Done", owner: { kind: "none" } },
];

/**
 * Every workflow in the org (Settings links here; a project's Workflow tab has "All workflows"):
 * its statuses as small dots and the projects on it. Opening one edits it with the same editor.
 */
export function WorkflowsPage({
  orgId,
  workflowId,
  onOpen,
}: {
  orgId: string;
  workflowId: string | undefined;
  onOpen: (workflowId: string | undefined) => void;
}) {
  const workflows = useQuery(flowWorkflowsQuery(orgId));
  const projects = useQuery(flowProjectsQuery(orgId));
  const refresh = useFlowRefresh(orgId);
  const [creating, setCreating] = useState(false);
  const list = workflows.data?.workflows ?? [];
  const chosen = workflowId ? list.find((w) => w.id === workflowId) : undefined;

  async function create() {
    setCreating(true);
    try {
      const made = await op(
        "flow.workflow.create",
        { orgId, name: "New workflow", statuses: STARTER },
        { idempotencyKey: submitKey() },
      );
      await refresh();
      onOpen(made.id);
    } catch (error) {
      toast.error(message(error));
    } finally {
      setCreating(false);
    }
  }

  return (
    <main className="flex min-w-0 flex-1 flex-col" data-testid="workflows-page">
      <PageHeader
        title={
          chosen ? (
            <span className="flex items-center gap-1.5">
              <button
                type="button"
                className="font-normal text-ink-muted hover:text-ink"
                onClick={() => onOpen(undefined)}
                data-testid="back-to-workflows"
              >
                Workflows
              </button>
              <span className="font-normal text-ink-faint">›</span>
              {chosen.workflow.name}
            </span>
          ) : (
            "Workflows"
          )
        }
      >
        <span className="flex-1" />
        {!chosen && (
          <Button
            size="md"
            disabled={creating}
            onClick={() => void create()}
            data-testid="new-workflow"
          >
            <PlusIcon />
            New workflow
          </Button>
        )}
      </PageHeader>
      {workflows.error ? (
        <p className="p-6 text-bad">Couldn't load the workflows. {workflows.error.message}</p>
      ) : chosen ? (
        <WorkflowEditor key={chosen.id} orgId={orgId} workflow={chosen} showName />
      ) : workflowId && workflows.isSuccess ? (
        <p className="p-6 text-ink-muted">That workflow isn't in this org.</p>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto bg-board px-5 py-5">
          {workflows.isSuccess && list.length === 0 ? (
            <p className="text-ink-muted">No workflows yet.</p>
          ) : (
            <ul
              className="max-w-[760px] overflow-hidden rounded-[10px] border border-line bg-panel"
              data-testid="workflow-list"
            >
              {list.map((w) => {
                const on = (projects.data?.projects ?? []).filter((p) => p.workflowId === w.id);
                const statuses = w.workflow.statuses;
                return (
                  <li key={w.id} className="border-line-soft border-b last:border-b-0">
                    <button
                      type="button"
                      onClick={() => onOpen(w.id)}
                      className="flex w-full items-center gap-4 px-3.5 py-3 text-left hover:bg-hover"
                      data-testid="workflow-row"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block font-medium">{w.workflow.name}</span>
                        <span className="mt-1 flex items-center gap-1" data-testid="workflow-dots">
                          {statuses.map((s, i) => (
                            <span key={s.id} title={s.name} className="inline-flex">
                              <StatusMark index={i} count={statuses.length} />
                            </span>
                          ))}
                          <span className="ml-1.5 text-[11.5px] text-ink-faint">
                            {statuses.length} status{statuses.length === 1 ? "" : "es"}
                          </span>
                        </span>
                      </span>
                      <span className="flex-none text-[12px] text-ink-muted">
                        {on.length ? on.map((p) => p.name).join(", ") : "No projects"}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </main>
  );
}

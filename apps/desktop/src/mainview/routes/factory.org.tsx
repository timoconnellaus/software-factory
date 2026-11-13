// Factory: Org workflows (spec 52, ADR 0516, 0610; design FactoryWorkflow's workflow list). The
// rail's org's own workflows and the built-in ones, a workflow's stages, and every org decision the
// website never had a screen for: edit and save a workflow, add one from a template, archive one,
// approve or reject a waiting org change, roll the org's workflows back, change an org agent, and
// move projects still on their own workflows onto org workflows (a dry run first; the real run is
// bound to the plan it showed). Each decision goes through `decide()` with Touch ID; reads only here.
import type { OpOutput } from "@software-factory/client/ops";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@software-factory/ui/components/alert-dialog";
import { Button } from "@software-factory/ui/components/button";
import { Input } from "@software-factory/ui/components/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@software-factory/ui/components/select";
import { Textarea } from "@software-factory/ui/components/textarea";
import { cn } from "@software-factory/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { createRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { CannotApproveYet, useCanDecide } from "../components/cannot-approve.tsx";
import {
  CharCount,
  ImpactChip,
  ImpactList,
  LeaveGuard,
  Segmented,
} from "../components/config-fields.tsx";
import { Cell, Empty, Row, TablePanel, When, WIDE } from "../components/data-table.tsx";
import { DiffRows } from "../components/diff-rows.tsx";
import { type OrgWorkflow, OrgWorkflowForm } from "../components/org-workflow-form.tsx";
import { Reads } from "../components/read-state.tsx";
import { Chip, PageArea, PageHeader, Panel, SectionTitle } from "../components/shell-list.tsx";
import { useOrgScope } from "../components/shell-sidebar.tsx";
import {
  type Agent,
  type AgentEdit,
  conflicts,
  keepOn,
  latestOf,
  openAgent,
  typeIn,
} from "../lib/agent-edit.ts";
import {
  orgConfigQuery,
  orgWorkflowQuery,
  orgWorkflowsQuery,
  stageTypesQuery,
} from "../lib/factory-queries.ts";
import { op, read } from "../lib/op.ts";
import {
  agentDiff,
  type DiffRow,
  orgConfigDiff,
  unreadable,
  workflowDiff,
} from "../lib/org-diff.ts";
import { usePolicyDecide } from "../lib/policy-decide.ts";
import { orgScope } from "../lib/scope.ts";
import { useSession } from "../lib/session.ts";
import { getViewState } from "../lib/view-state.ts";
import { factoryLayout } from "./_factory.tsx";

interface Search {
  workflow?: string;
  edit?: boolean;
}

export const Route = createRoute({
  getParentRoute: () => factoryLayout,
  path: "/factory/org-workflows",
  validateSearch: (s: Record<string, unknown>): Search => ({
    ...(typeof s.workflow === "string" ? { workflow: s.workflow } : {}),
    ...(s.edit === true || s.edit === "1" || s.edit === "true" ? { edit: true } : {}),
  }),
  loaderDeps: ({ search }) => ({ workflow: search.workflow, edit: !!search.edit }),
  loader: async ({ context, deps }) => {
    const orgId = orgScope(context.session, getViewState().orgId);
    if (!orgId) return;
    const q = context.queryClient;
    await Promise.all([
      q.ensureQueryData(orgConfigQuery(orgId)),
      q.ensureQueryData(orgWorkflowsQuery(orgId)),
      ...(deps.workflow ? [q.ensureQueryData(orgWorkflowQuery(orgId, deps.workflow))] : []),
      ...(deps.edit ? [q.ensureQueryData(stageTypesQuery())] : []),
    ]).catch(() => null);
  },
  component: OrgWorkflowsPage,
});

type Listed = OpOutput<"workflow.list">["workflows"][number];

function OrgWorkflowsPage() {
  const search = Route.useSearch();
  const orgId = useOrgScope();
  const session = useSession();
  const org = session.orgs.find((o) => o.id === orgId);
  const config = useQuery({ ...orgConfigQuery(orgId ?? ""), enabled: !!orgId });
  const list = useQuery({ ...orgWorkflowsQuery(orgId ?? ""), enabled: !!orgId });
  const workflows = list.data?.workflows ?? [];
  const shown = workflows.find((w) => w.id === search.workflow) ?? workflows[0] ?? null;
  if (!orgId) return <Empty>Choose an org in the rail to see its workflows.</Empty>;
  return (
    <PageArea>
      <PageHeader
        above={org?.name}
        title="Org workflows"
        sub="Workflows the org's projects can run. A change that loosens one waits for an org admin; every decision here asks for Touch ID."
        actions={
          list.data && (
            <NewFromTemplate
              orgId={orgId}
              baseVersion={list.data.version}
              templates={list.data.templates}
            />
          )
        }
      />
      <Reads queries={[config, list]} what="the org's workflows">
        {() => (
          <>
            {config.data && <PendingOrgChanges config={config.data} />}
            {search.edit && shown && !shown.builtIn ? (
              <EditOne orgId={orgId} workflowId={shown.id} config={config.data} />
            ) : (
              <>
                <WorkflowTable workflows={workflows} shown={shown} />
                {shown && (
                  <WorkflowStages
                    orgId={orgId}
                    workflow={shown}
                    baseVersion={list.data?.version ?? 0}
                  />
                )}
                <OrgAgents orgId={orgId} config={config.data} />
                <AdoptProjects orgId={orgId} baseVersion={list.data?.version ?? 0} />
                <OrgHistory orgId={orgId} config={config.data} />
              </>
            )}
          </>
        )}
      </Reads>
    </PageArea>
  );
}

function WorkflowTable({ workflows, shown }: { workflows: Listed[]; shown: Listed | null }) {
  if (workflows.length === 0)
    return <Empty>The org has no workflows of its own yet. Add one from a template.</Empty>;
  return (
    <TablePanel head={["Workflow", "Stages", ""]} data-testid="org-workflows">
      {workflows.map((w) => (
        <Row
          key={w.id}
          aria-current={w.id === shown?.id ? "true" : undefined}
          className={cn(w.id === shown?.id && "bg-selected/60")}
        >
          <Cell className="font-medium">
            <Link
              to="/factory/org-workflows"
              search={{ workflow: w.id }}
              className="hover:underline"
            >
              {w.name}
            </Link>
          </Cell>
          <Cell className="whitespace-normal text-ink-3">
            {w.stages.map((s) => s.name).join(", ")}
          </Cell>
          <Cell>{w.builtIn ? <Chip>Built in</Chip> : ""}</Cell>
        </Row>
      ))}
    </TablePanel>
  );
}

function WorkflowStages({
  orgId,
  workflow,
  baseVersion,
}: {
  orgId: string;
  workflow: Listed;
  baseVersion: number;
}) {
  const { run, pending } = usePolicyDecide();
  const canDecide = useCanDecide();
  const navigate = useNavigate();
  const [archiving, setArchiving] = useState(false);
  return (
    <section className="flex flex-col gap-2" data-testid="org-workflow-stages">
      <div className="flex flex-wrap items-center gap-2">
        <SectionTitle
          className="min-w-[min(100%,300px)] flex-1"
          note={workflow.description || undefined}
        >
          {workflow.name}: stages
        </SectionTitle>
        {!workflow.builtIn && (
          <>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setArchiving(true)}
              disabled={!canDecide}
            >
              Archive
            </Button>
            <Button size="sm" asChild>
              <Link
                to="/factory/org-workflows"
                search={{ workflow: workflow.id, edit: true }}
                data-testid="edit-org-workflow"
              >
                Edit workflow
              </Link>
            </Button>
          </>
        )}
      </div>
      <Panel className="gap-0 py-0">
        {workflow.stages.map((s, i) => (
          <div
            key={s.id}
            className="flex flex-wrap items-center gap-2 border-line-soft border-b py-2.5 text-[13px] last:border-b-0"
          >
            <span className="font-semibold">
              {i + 1}. {s.name}
            </span>
            <Chip>{s.type}</Chip>
            <span className="text-ink-3 text-xs">{s.phase}</span>
          </div>
        ))}
      </Panel>
      <AlertDialog open={archiving} onOpenChange={setArchiving}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Archive {workflow.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              It leaves the org's workflows as a new version; a rollback brings it back. A workflow
              a project runs can't be archived.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={pending !== null}
              onClick={async () => {
                const out = await run(
                  "workflow.archive",
                  { orgId, baseVersion, workflowId: workflow.id },
                  `Archived ${workflow.name}`,
                );
                if (out) void navigate({ to: "/factory/org-workflows", search: {} });
              }}
            >
              Archive
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

function EditOne({
  orgId,
  workflowId,
  config,
}: {
  orgId: string;
  workflowId: string;
  config: OpOutput<"orgConfig.get"> | undefined;
}) {
  const navigate = useNavigate();
  const got = useQuery(orgWorkflowQuery(orgId, workflowId));
  const agents = (Array.isArray(config?.config.agents) ? config.config.agents : []) as {
    name: string;
  }[];
  return (
    <Reads queries={[got]} what="the workflow">
      {() =>
        got.data && (
          <>
            <div className="flex items-center gap-2">
              <SectionTitle>Editing {String(got.data.workflow.name)}</SectionTitle>
              <span className="grow" />
              <Button size="sm" variant="outline" asChild>
                <Link to="/factory/org-workflows" search={{ workflow: workflowId }}>
                  Done
                </Link>
              </Button>
            </div>
            <CannotApproveYet />
            <OrgWorkflowForm
              key={`${orgId}:${workflowId}`}
              orgId={orgId}
              baseVersion={got.data.version}
              saved={got.data.workflow as unknown as OrgWorkflow}
              agents={agents.map((a) => a.name)}
              onDone={() =>
                void navigate({ to: "/factory/org-workflows", search: { workflow: workflowId } })
              }
            />
          </>
        )
      }
    </Reads>
  );
}

function NewFromTemplate({
  orgId,
  baseVersion,
  templates,
}: {
  orgId: string;
  baseVersion: number;
  templates: Listed[];
}) {
  const [open, setOpen] = useState(false);
  const [templateId, setTemplateId] = useState(templates[0]?.id ?? "");
  const [name, setName] = useState("");
  const { run, pending } = usePolicyDecide();
  const canDecide = useCanDecide();
  const navigate = useNavigate();
  if (templates.length === 0) return null;
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)} disabled={!canDecide}>
        New from a template
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>A new org workflow</AlertDialogTitle>
            <AlertDialogDescription>
              A copy of the template, to edit. No project runs it yet, so it applies at once.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="flex flex-col gap-2">
            <Select value={templateId} onValueChange={setTemplateId}>
              <SelectTrigger size="sm" aria-label="Template">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {templates.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              aria-label="Name"
              placeholder="Name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={!name.trim() || pending !== null}
              onClick={async () => {
                const out = (await run(
                  "workflow.createFromTemplate",
                  { orgId, baseVersion, templateId, name: name.trim() },
                  `Added ${name.trim()}`,
                )) as { workflowId?: string } | null;
                if (out?.workflowId)
                  void navigate({
                    to: "/factory/org-workflows",
                    search: { workflow: out.workflowId, edit: true },
                  });
              }}
            >
              Add
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/** A waiting org change's operation, in words. */
const OPERATION_WORDS: Record<string, string> = {
  "workflow.save": "Save a workflow",
  "agent.save": "Save an agent",
  "workflow.archive": "Archive a workflow",
  "workflow.createFromTemplate": "Add a workflow",
  "orgConfig.rollback": "Roll back",
};

type Pending = OpOutput<"orgConfig.get">["pending"][number];

/** Why a waiting org change can't be approved here, or null (pure; tested). */
export function cannotApproveOrg(p: Pending, version: number): string | null {
  // Fail closed: a change that doesn't say which version it was drafted on can't apply here.
  if (p.baseVersion === null || p.baseVersion !== version)
    return `This was drafted on ${p.baseVersion === null ? "an unknown version" : `v${p.baseVersion}`}; the org's workflows are now v${version}, so it can't apply. Reject it and propose it again.`;
  if (!p.impact)
    return "The engine couldn't classify this change, so it can't be approved here. Reject it, or look again later.";
  if (!p.proposal)
    return "This change can't be shown: what it would make current isn't readable. Reject it.";
  const rows = differenceOf(p);
  if (unreadable(rows))
    return "Part of this change can't be shown here (the two sides read the same). Reject it, and look at it again.";
  // Nothing shown is nothing to approve.
  if (rows.length === 0) return "This change changes nothing this screen can show. Reject it.";
  return null;
}

/** The rows of a waiting change's difference (every field), for workflows and agents. */
export function differenceOf(p: Pending): DiffRow[] {
  if (p.operation === "workflow.save") return workflowDiff(p.current, p.proposal);
  if (p.operation === "agent.save") return agentDiff(p.current, p.proposal);
  if (p.operation === "orgConfig.rollback") return orgConfigDiff(p.current, p.proposal);
  return [];
}

/**
 * Org changes waiting for an org admin: each with the engine's classification against the current
 * version and the difference itself, then Approve (only once both are on screen) or Reject, each
 * with Touch ID. One that can't be shown or no longer applies can only be rejected.
 */
function PendingOrgChanges({ config }: { config: OpOutput<"orgConfig.get"> }) {
  const { run, pending: busy } = usePolicyDecide();
  const canDecide = useCanDecide();
  const pending = config.pending;
  if (pending.length === 0) return null;
  return (
    <section className="flex flex-col gap-2" data-testid="org-pending">
      <SectionTitle>
        {pending.length === 1
          ? "1 change is waiting for an org admin"
          : `${pending.length} changes are waiting for an org admin`}
      </SectionTitle>
      <CannotApproveYet />
      {pending.map((p) => {
        const why = cannotApproveOrg(p, config.version);
        return (
          <Panel key={p.pendingActionId} needsYou data-testid={`org-pending-${p.pendingActionId}`}>
            <div className="flex flex-wrap items-center gap-2">
              <span className="min-w-[min(100%,280px)] flex-1 text-[13px]">
                <span className="font-medium">
                  {`${OPERATION_WORDS[p.operation] ?? p.operation}${p.note ? `: ${p.note}` : ""}`}
                </span>
                <span className="text-ink-3 text-xs">{p.by ? ` · by ${p.by}` : ""}</span>
              </span>
              {(["approved", "rejected"] as const)
                .filter((d) => d === "rejected" || !why)
                .map((decision) => (
                  <Button
                    key={decision}
                    size="sm"
                    variant={decision === "approved" ? "default" : "outline"}
                    disabled={busy !== null || !canDecide}
                    data-testid={`org-pending-${decision === "approved" ? "approve" : "reject"}`}
                    onClick={() =>
                      void run(
                        "approval.decide",
                        { pendingActionId: p.pendingActionId, decision },
                        decision === "approved" ? "Approved" : "Rejected",
                        `${p.pendingActionId}:${decision}`,
                      )
                    }
                  >
                    {decision === "approved" ? "Approve" : "Reject"}
                  </Button>
                ))}
            </div>
            {why ? (
              <div className="text-ink-3 text-xs" data-testid="org-pending-why">
                {why}
              </div>
            ) : (
              <>
                {p.impact && <ImpactList changes={p.impact.changes} testId="org-pending-impact" />}
                <OrgDifference change={p} />
              </>
            )}
          </Panel>
        );
      })}
    </section>
  );
}

/** What a waiting org change would change, field by field, before and after. */
function OrgDifference({ change }: { change: Pending }) {
  return (
    <>
      {change.operation === "orgConfig.rollback" && (
        <div className="text-ink-3 text-xs">Back to v{change.toVersion}, as a new version:</div>
      )}
      <DiffRows rows={differenceOf(change)} testId="org-pending-diff" />
    </>
  );
}

const ROLES = ["triage", "implement", "review", "summarise"].map((r) => ({ value: r, label: r }));

/** The org's agents: change one (Touch ID); changing one that judges work waits for an org admin. */
function OrgAgents({
  orgId,
  config,
}: {
  orgId: string;
  config: OpOutput<"orgConfig.get"> | undefined;
}) {
  const agents = (Array.isArray(config?.config.agents) ? config.config.agents : []) as Agent[];
  // The edit and the version it is based on (lib/agent-edit.ts): typing never re-bases it.
  const [edit, setEdit] = useState<AgentEdit | null>(null);
  const editing = edit?.draft ?? null;
  const version = config?.version ?? 0;
  const latest = edit ? latestOf(agents, edit) : null;
  const agentMoved = edit !== null && edit.base !== version;
  // A new agent named like an existing one would replace it: refused here (review of #159).
  const nameTaken = edit !== null && edit.original.name === "" && latest !== null;
  const type = (patch: Partial<Agent>) => setEdit((e) => (e ? typeIn(e, patch) : e));
  const { run, pending } = usePolicyDecide();
  const canDecide = useCanDecide();
  return (
    <section className="flex flex-col gap-2" data-testid="org-agents">
      <div className="flex flex-wrap items-center gap-2">
        <SectionTitle
          className="min-w-[min(100%,300px)] flex-1"
          note="Stages hand to them by name."
        >
          Org agents
        </SectionTitle>
        <span className="grow" />
        <Button
          size="sm"
          variant="outline"
          disabled={!canDecide}
          onClick={() =>
            setEdit(
              openAgent({ name: "", role: "review", tier: "standard", instructions: "" }, version),
            )
          }
        >
          Add an agent
        </Button>
      </div>
      {agents.length === 0 ? (
        <Empty>No org agents yet: stages use their types' built-in ones.</Empty>
      ) : (
        <TablePanel head={["Agent", "Role", { label: "Tier", className: WIDE }, ""]}>
          {agents.map((a) => (
            <Row key={a.name}>
              <Cell className="font-medium">{a.name}</Cell>
              <Cell>{a.role}</Cell>
              <Cell className={WIDE}>{a.tier ?? "standard"}</Cell>
              <Cell className="text-right">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setEdit(openAgent(a, version))}
                  disabled={!canDecide}
                >
                  Edit
                </Button>
              </Cell>
            </Row>
          ))}
        </TablePanel>
      )}
      <LeaveGuard
        dirty={edit !== null && JSON.stringify(edit.draft) !== JSON.stringify(edit.original)}
      />
      {editing && (
        <Panel className="gap-2" data-testid="org-agent-form">
          <div className="flex flex-wrap items-center gap-2">
            <Input
              className="h-8 w-44"
              aria-label="Agent name"
              placeholder="Name"
              value={editing.name}
              onChange={(e) => type({ name: e.target.value })}
            />
            <Select value={editing.role} onValueChange={(role) => type({ role })}>
              <SelectTrigger size="sm" className="w-[150px]" aria-label="Role">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ROLES.map((r) => (
                  <SelectItem key={r.value} value={r.value}>
                    {r.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Segmented
              label="Tier"
              options={["standard", "light"]}
              value={editing.tier ?? "standard"}
              onChange={(tier) => type({ tier })}
            />
          </div>
          <Textarea
            className="min-h-16 text-[13px]"
            aria-label="Instructions"
            placeholder="Standing instructions, added to every job this agent runs"
            value={editing.instructions ?? ""}
            onChange={(e) => type({ instructions: e.target.value })}
          />
          <CharCount value={editing.instructions ?? ""} />
          {nameTaken && (
            <div className="text-[13px] text-chip-amber-ink" data-testid="org-agent-name-taken">
              The org already has an agent called {latest?.name}: saving would replace it. Choose
              another name, or edit {latest?.name} instead.
            </div>
          )}
          {agentMoved && (
            <div className="flex flex-col gap-2 text-[13px]" data-testid="org-agent-moved">
              <span>
                The org's workflows changed while you were editing (v{edit?.base} → v{version}).
                What changed in this agent since you opened it:
              </span>
              <DiffRows rows={agentDiff(edit?.original, latest)} />
              {agentDiff(edit?.original, latest).length === 0 && (
                <span className="text-ink-3 text-xs">Nothing in this agent.</span>
              )}
              {edit && conflicts(edit, latest).length > 0 && (
                <span className="text-xs">
                  Keeping your changes replaces theirs in: {conflicts(edit, latest).join(", ")}. The
                  rest of their change stays.
                </span>
              )}
              <Button
                size="sm"
                variant="outline"
                className="w-fit"
                onClick={() => setEdit((e) => (e ? keepOn(e, latest, version) : e))}
              >
                Keep my changes on v{config?.version}
              </Button>
            </div>
          )}
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={
                !editing.name.trim() || pending !== null || !canDecide || agentMoved || nameTaken
              }
              onClick={async () => {
                const out = await run(
                  "agent.save",
                  {
                    orgId,
                    baseVersion: edit?.base ?? version,
                    agent: { ...editing, name: editing.name.trim() },
                  },
                  `Saved ${editing.name.trim()}`,
                );
                if (out) setEdit(null);
              }}
            >
              Save agent
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEdit(null)}>
              Cancel
            </Button>
          </div>
        </Panel>
      )}
    </section>
  );
}

type Plan = OpOutput<"orgConfig.adoptProjectWorkflows">;

/** Projects still on their own workflows, moved onto org workflows: a dry run, then exactly it. */
function AdoptProjects({ orgId, baseVersion }: { orgId: string; baseVersion: number }) {
  const [plan, setPlan] = useState<Plan | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { run, pending } = usePolicyDecide();
  const canDecide = useCanDecide();
  return (
    <section className="flex flex-col gap-2" data-testid="org-adopt">
      <div className="flex flex-wrap items-center gap-2">
        <SectionTitle
          className="min-w-[min(100%,300px)] flex-1"
          note="Nothing an item does changes; a project whose move wouldn't be neutral stays as it is."
        >
          Projects on their own workflows
        </SectionTitle>
        <span className="grow" />
        <Button
          size="sm"
          variant="outline"
          disabled={checking}
          onClick={async () => {
            setChecking(true);
            setError(null);
            try {
              setPlan(
                await op("orgConfig.adoptProjectWorkflows", { orgId, baseVersion, dryRun: true }),
              );
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
            } finally {
              setChecking(false);
            }
          }}
        >
          {checking ? "Checking…" : "Check what would move"}
        </Button>
      </div>
      {error && <div className="text-chip-amber-ink text-xs">{error}</div>}
      {plan && (
        <Panel className="gap-2" data-testid="adopt-plan">
          {plan.projects.length === 0 ? (
            <span className="text-[13px]">
              Nothing to move: every project is on an org workflow.
            </span>
          ) : (
            <>
              <ul className="m-0 flex list-none flex-col gap-1 p-0 text-[13px]">
                {plan.projects.map((p) => (
                  <li key={p.projectId}>
                    <span className="font-medium">{p.name}</span>: {p.from ?? "the stages alone"} →{" "}
                    {plan.workflows.find((w) => w.id === p.workflow)?.name ?? p.workflow}
                    {p.approved.length
                      ? ` (looser overrides approved: ${p.approved.join(", ")})`
                      : ""}
                  </li>
                ))}
              </ul>
              <div>
                <Button
                  size="sm"
                  disabled={pending !== null || !canDecide}
                  onClick={async () => {
                    const out = await run(
                      "orgConfig.adoptProjectWorkflows",
                      { orgId, baseVersion, dryRun: false, planDigest: plan.planDigest },
                      "Moved",
                    );
                    if (out) setPlan(null);
                  }}
                >
                  Move{" "}
                  {plan.projects.length === 1
                    ? "this project"
                    : `these ${plan.projects.length} projects`}
                </Button>
              </div>
            </>
          )}
          {plan.skipped.length > 0 && (
            <div className="flex flex-col gap-0.5 border-line-soft border-t pt-2 text-xs">
              <span className="font-medium text-ink-3">Staying as they are</span>
              {plan.skipped.map((s) => (
                <span key={s.projectId} className="text-ink-3">
                  {s.name}: {s.reason}
                </span>
              ))}
            </div>
          )}
        </Panel>
      )}
    </section>
  );
}

/** The org's versions: what each loosened or tightened, and a rollback (Touch ID). */
function OrgHistory({
  orgId,
  config,
}: {
  orgId: string;
  config: OpOutput<"orgConfig.get"> | undefined;
}) {
  const [confirm, setConfirm] = useState<number | null>(null);
  const { run, pending } = usePolicyDecide();
  const canDecide = useCanDecide();
  const history = config?.history ?? [];
  // The engine's classification of the rollback, before the person confirms it.
  const preview = useQuery({
    queryKey: ["orgConfig", orgId, "previewRollback", confirm],
    queryFn: () => read("orgConfig.previewRollback", { orgId, toVersion: confirm ?? 0 }),
    enabled: confirm !== null,
  });
  if (history.length === 0) return null;
  return (
    <section className="flex flex-col gap-2" data-testid="org-history">
      <SectionTitle note="Newest first. Rolling back makes a new version.">History</SectionTitle>
      <Panel className="gap-0 py-0">
        {history.map((h) => (
          <div
            key={h.version}
            className="flex flex-wrap items-center gap-x-2 gap-y-0.5 border-line-soft border-b py-2 text-[13px] last:border-b-0"
          >
            <span className="font-mono text-xs">v{h.version}</span>
            {h.impact && h.impact !== "neutral" && <ImpactChip value={h.impact} />}
            <span className="grow" />
            <When iso={h.createdAt} className="text-ink-muted text-xs" />
            {h.version === config?.version ? (
              <Chip>current</Chip>
            ) : (
              <Button
                size="sm"
                variant="outline"
                className="h-7"
                disabled={!canDecide}
                onClick={() => setConfirm(h.version)}
              >
                Roll back
              </Button>
            )}
            <span className="basis-full text-ink-3 text-xs">{h.note ?? h.source}</span>
          </div>
        ))}
      </Panel>
      <AlertDialog open={confirm !== null} onOpenChange={(o) => !o && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Make v{confirm} current again?</AlertDialogTitle>
            <AlertDialogDescription>
              {!preview.data
                ? preview.isError
                  ? "The engine couldn't classify this rollback, so it can't be confirmed here."
                  : "Classifying the change…"
                : preview.data.impact.class === "loosens"
                  ? `It saves v${confirm} as a new version. It loosens the org's workflows, so it waits for an org admin.`
                  : `It saves v${confirm} as a new version, at once.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {preview.data && (
            <div
              className="flex max-h-64 flex-col gap-2 overflow-y-auto"
              data-testid="org-rollback-preview"
            >
              <ImpactList changes={preview.data.impact.changes} />
              <div className="rounded-lg bg-page px-3 py-2 text-xs">
                <div>
                  <span className="text-ink-3">Workflows now: </span>
                  {preview.data.before.map((w) => w.name).join(", ") || "none"}
                </div>
                <div>
                  <span className="text-ink-3">After: </span>
                  <span className="font-medium">
                    {preview.data.after.map((w) => w.name).join(", ") || "none"}
                  </span>
                </div>
              </div>
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={pending !== null || !preview.data || preview.isFetching || preview.isError}
              onClick={() => {
                const toVersion = confirm;
                const base = preview.data?.currentVersion;
                setConfirm(null);
                if (toVersion !== null)
                  void run(
                    "orgConfig.rollback",
                    // The version the person saw classified: a newer one is refused (conflict).
                    { orgId, baseVersion: base ?? 0, toVersion },
                    `Rolled back to v${toVersion}`,
                  );
              }}
            >
              Roll back
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

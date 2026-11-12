// A project's workflows and agents (ADR 0371, 0372, spec 09 M2). The skeleton (triage → spec →
// spec gate → build → verify → merge gate → merge queue) is fixed; a workflow fills its three slots
// with work steps (an agent, advisory) and gate steps (a person). Saved with the rest of the config.
import { Badge } from "@software-factory/ui/components/badge";
import { Button } from "@software-factory/ui/components/button";
import { Card } from "@software-factory/ui/components/card";
import { Input } from "@software-factory/ui/components/input";
import { Textarea } from "@software-factory/ui/components/textarea";
import { cn } from "@software-factory/ui/lib/utils";
import { createFileRoute, Link } from "@tanstack/react-router";
import { LockIcon } from "lucide-react";
import { type ReactNode, useState } from "react";
import {
  Page,
  PendingChanges,
  SaveBar,
  Section,
  Segmented,
  useConfigDraft,
} from "#/components/config-editor";
import { configQuery } from "#/lib/queries";
import { useProjects } from "#/lib/session";

export const Route = createFileRoute("/_app/projects/$projectId/workflows")({
  loader: ({ context: { queryClient }, params }) =>
    queryClient.ensureQueryData(configQuery(params.projectId)).catch(() => null),
  component: WorkflowsPage,
});

const ROLES = ["triage", "implement", "review", "summarise"] as const;
const SLOTS = [
  ["afterSpec", "After the spec", "Runs once, before the build"],
  ["beforeVerify", "Before verify", "After each build, on its branch"],
  ["afterVerify", "After verify", "Once verify passes, before the merge gate"],
] as const;
type Slot = (typeof SLOTS)[number][0];
type Step = {
  id: string;
  kind: "work" | "gate";
  name: string;
  agent?: string;
  approver?: string;
  instructions?: string;
  when?: { sizeAtLeast?: string; domain?: string };
};
type Agent = {
  name: string;
  role: string;
  tier?: string;
  instructions?: string;
  requires?: string[];
};
type Workflow = {
  name: string;
  description?: string;
  slots?: Partial<Record<Slot, Step[]>>;
  core?: { build?: string };
};

function WorkflowsPage() {
  const { projectId } = Route.useParams();
  const projects = useProjects();
  const project = projects.data?.find((p) => p.id === projectId);
  const editor = useConfigDraft(projectId);
  const { doc, set, config } = editor;
  const [selected, setSelected] = useState(0);

  if (!doc) {
    return (
      <Page title="Workflows and agents">
        <Card className="px-5 py-4 text-sm">
          {config.isPending ? "Loading…" : "This project has no config yet."}
        </Card>
      </Page>
    );
  }
  const agents = (Array.isArray(doc.agents) ? doc.agents : []) as Agent[];
  const workflows = (Array.isArray(doc.workflows) ? doc.workflows : []) as Workflow[];
  const index = Math.min(selected, Math.max(workflows.length - 1, 0));
  const wf = workflows[index];

  const setAgents = (fn: (a: Agent[]) => void) =>
    set((d) => {
      const list = structuredClone((Array.isArray(d.agents) ? d.agents : []) as Agent[]);
      fn(list);
      d.agents = list;
    });
  const setWorkflow = (fn: (w: Workflow) => void) =>
    set((d) => {
      const list = structuredClone((Array.isArray(d.workflows) ? d.workflows : []) as Workflow[]);
      const target = list[index];
      if (target) fn(target);
      d.workflows = list;
    });

  return (
    <Page
      title="Workflows and agents"
      subtitle={
        <>
          {project?.name ?? "Project"} · config{" "}
          <span className="font-mono">v{editor.currentVersion}</span> · Triage picks a workflow per
          work item. Workflows only add steps: the gates in the skeleton always run.
        </>
      }
      actions={
        <Button size="sm" variant="outline" asChild>
          <Link to="/projects/$projectId/settings" params={{ projectId }}>
            Settings
          </Link>
        </Button>
      }
    >
      <PendingChanges editor={editor} />

      <Section
        title="Workflows"
        description="Pick one to edit. With none, every item follows the skeleton alone."
      >
        <div className="flex flex-wrap items-center gap-1.5" data-testid="workflow-picker">
          {workflows.map((w, i) => (
            <Button
              // biome-ignore lint/suspicious/noArrayIndexKey: names can repeat while being edited; position is the identity.
              key={`${w.name}-${i}`}
              size="sm"
              variant={i === index ? "default" : "outline"}
              onClick={() => setSelected(i)}
            >
              {w.name || "(unnamed)"}
            </Button>
          ))}
          <Button
            size="sm"
            variant="ghost"
            data-testid="new-workflow"
            onClick={() => {
              set((d) => {
                const list = (Array.isArray(d.workflows) ? d.workflows : []) as Workflow[];
                d.workflows = [
                  ...list,
                  { name: `Workflow ${list.length + 1}`, description: "", slots: {}, core: {} },
                ];
              });
              setSelected(workflows.length);
            }}
          >
            + New workflow
          </Button>
        </div>
        {wf && (
          <WorkflowEditor
            workflow={wf}
            agents={agents}
            onChange={setWorkflow}
            onRemove={() => {
              set((d) => {
                const list = (Array.isArray(d.workflows) ? d.workflows : []) as Workflow[];
                d.workflows = list.filter((_, i) => i !== index);
              });
              setSelected(0);
            }}
          />
        )}
      </Section>

      <Section
        title="Agents"
        description="Profiles steps hand to. An agent names a model role and tier, never a model: the runner that takes the job picks the model, on its owner's subscription."
      >
        <AgentsEditor agents={agents} onChange={setAgents} />
      </Section>

      <SaveBar editor={editor} />
    </Page>
  );
}

function WorkflowEditor({
  workflow,
  agents,
  onChange,
  onRemove,
}: {
  workflow: Workflow;
  agents: Agent[];
  onChange: (fn: (w: Workflow) => void) => void;
  onRemove: () => void;
}) {
  const slots = workflow.slots ?? {};
  const builders = agents.filter((a) => a.role === "implement");
  const reporters = agents.filter((a) => a.role !== "implement");
  const addStep = (slot: Slot, kind: "work" | "gate") =>
    onChange((w) => {
      w.slots = w.slots ?? {};
      const list = w.slots[slot] ?? [];
      const ids = new Set(Object.values(w.slots).flatMap((l) => (l ?? []).map((s) => s.id)));
      let id = kind === "work" ? "review" : "sign-off";
      for (let n = 2; ids.has(id); n++) id = `${kind === "work" ? "review" : "sign-off"}-${n}`;
      list.push(
        kind === "work"
          ? { id, kind, name: "Review", agent: reporters[0]?.name ?? "", instructions: "" }
          : { id, kind, name: "Sign-off", instructions: "" },
      );
      w.slots[slot] = list;
    });
  return (
    <div className="grid gap-3 pt-2" data-testid="workflow-editor">
      <div className="grid gap-2 md:grid-cols-[1fr_2fr_auto]">
        <Input
          value={workflow.name}
          aria-label="Workflow name"
          onChange={(e) =>
            onChange((w) => {
              w.name = e.target.value;
            })
          }
        />
        <Input
          value={workflow.description ?? ""}
          placeholder="When triage should pick it"
          aria-label="Workflow description"
          onChange={(e) =>
            onChange((w) => {
              w.description = e.target.value;
            })
          }
        />
        <Button size="sm" variant="ghost" onClick={onRemove}>
          Remove workflow
        </Button>
      </div>

      <ol className="grid gap-2" data-testid="skeleton">
        <Core name="Triage" detail="Sizes the item and picks this workflow" />
        <Core name="Spec + spec gate" detail="When the item is at least the project's spec size" />
        <SlotView
          slot="afterSpec"
          steps={slots.afterSpec ?? []}
          agents={reporters}
          onAdd={addStep}
          onChange={onChange}
        />
        <Core name="Build" detail="Role implement">
          <select
            className="h-8 rounded-md border bg-background px-2 text-sm"
            aria-label="Build agent"
            value={workflow.core?.build ?? ""}
            onChange={(e) =>
              onChange((w) => {
                w.core = e.target.value ? { build: e.target.value } : {};
              })
            }
          >
            <option value="">Default builder</option>
            {builders.map((a) => (
              <option key={a.name}>{a.name}</option>
            ))}
          </select>
        </Core>
        <SlotView
          slot="beforeVerify"
          steps={slots.beforeVerify ?? []}
          agents={reporters}
          onAdd={addStep}
          onChange={onChange}
        />
        <Core name="Verify" detail="CI and the independent reviewer: set in code" />
        <SlotView
          slot="afterVerify"
          steps={slots.afterVerify ?? []}
          agents={reporters}
          onAdd={addStep}
          onChange={onChange}
        />
        <Core name="Merge gate" detail="Always a person" />
        <Core name="Merge queue" detail="Lands one at a time" />
      </ol>
    </div>
  );
}

function Core({ name, detail, children }: { name: string; detail: string; children?: ReactNode }) {
  return (
    <li className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2">
      <LockIcon className="size-3.5 text-muted-foreground" />
      <span className="font-medium text-sm">{name}</span>
      <span className="text-muted-foreground text-xs">{detail}</span>
      <span className="grow" />
      {children}
    </li>
  );
}

function SlotView({
  slot,
  steps,
  agents,
  onAdd,
  onChange,
}: {
  slot: Slot;
  steps: Step[];
  agents: Agent[];
  onAdd: (slot: Slot, kind: "work" | "gate") => void;
  onChange: (fn: (w: Workflow) => void) => void;
}) {
  const meta = SLOTS.find((s) => s[0] === slot);
  const edit = (i: number, fn: (s: Step) => void) =>
    onChange((w) => {
      const step = w.slots?.[slot]?.[i];
      if (step) fn(step);
    });
  const move = (i: number, by: -1 | 1) =>
    onChange((w) => {
      const list = w.slots?.[slot];
      const j = i + by;
      if (!list || j < 0 || j >= list.length) return;
      [list[i], list[j]] = [list[j] as Step, list[i] as Step];
    });
  return (
    <li
      className="grid gap-2 rounded-lg border border-dashed px-3 py-2"
      data-testid={`slot-${slot}`}
    >
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="font-medium">{meta?.[1]}</span>
        <span className="text-muted-foreground">{meta?.[2]}</span>
        <span className="grow" />
        <Button size="sm" variant="ghost" className="h-7" onClick={() => onAdd(slot, "work")}>
          + Work step
        </Button>
        <Button size="sm" variant="ghost" className="h-7" onClick={() => onAdd(slot, "gate")}>
          + Gate step
        </Button>
      </div>
      {steps.map((s, i) => (
        <StepEditor
          key={s.id}
          step={s}
          agents={agents}
          onChange={(fn) => edit(i, fn)}
          onMove={(by) => move(i, by)}
          onRemove={() =>
            onChange((w) => {
              if (w.slots?.[slot]) w.slots[slot] = w.slots[slot]?.filter((_, j) => j !== i);
            })
          }
        />
      ))}
    </li>
  );
}

function StepEditor({
  step,
  agents,
  onChange,
  onMove,
  onRemove,
}: {
  step: Step;
  agents: Agent[];
  onChange: (fn: (s: Step) => void) => void;
  onMove: (by: -1 | 1) => void;
  onRemove: () => void;
}) {
  return (
    <Card className="gap-2 px-3 py-2" data-testid={`step-${step.id}`}>
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={step.kind === "gate" ? "default" : "secondary"}>
          {step.kind === "gate" ? "gate · a person" : "work · advisory"}
        </Badge>
        <Input
          className="h-8 w-48"
          value={step.name}
          aria-label="Step name"
          onChange={(e) =>
            onChange((s) => {
              s.name = e.target.value;
            })
          }
        />
        <span className="font-mono text-muted-foreground text-xs">{step.id}</span>
        {step.kind === "work" ? (
          <select
            className="h-8 rounded-md border bg-background px-2 text-sm"
            aria-label="Agent"
            value={step.agent ?? ""}
            onChange={(e) =>
              onChange((s) => {
                s.agent = e.target.value;
              })
            }
          >
            <option value="" disabled>
              Pick an agent
            </option>
            {agents.map((a) => (
              <option key={a.name}>{a.name}</option>
            ))}
          </select>
        ) : (
          <Input
            className="h-8 w-44"
            placeholder="approver login (or approvers)"
            value={step.approver ?? ""}
            onChange={(e) =>
              onChange((s) => {
                if (e.target.value.trim()) s.approver = e.target.value.trim();
                else delete s.approver;
              })
            }
          />
        )}
        <span className="grow" />
        <Button
          size="sm"
          variant="ghost"
          className="h-7"
          aria-label="Up"
          onClick={() => onMove(-1)}
        >
          ▲
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7"
          aria-label="Down"
          onClick={() => onMove(1)}
        >
          ▼
        </Button>
        <Button size="sm" variant="ghost" className="h-7" onClick={onRemove}>
          Remove
        </Button>
      </div>
      <Textarea
        className="min-h-16 text-sm"
        placeholder={
          step.kind === "work"
            ? "What this step checks. It reads the branch and reports: pass, send back to build, or ask a person."
            : "What the person should check before the item goes on."
        }
        value={step.instructions ?? ""}
        onChange={(e) =>
          onChange((s) => {
            s.instructions = e.target.value;
          })
        }
      />
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-muted-foreground">Only when</span>
        <select
          className="h-7 rounded-md border bg-background px-1.5"
          aria-label="Size at least"
          value={step.when?.sizeAtLeast ?? ""}
          onChange={(e) =>
            onChange((s) => {
              const when = { ...(s.when ?? {}) };
              if (e.target.value) when.sizeAtLeast = e.target.value;
              else delete when.sizeAtLeast;
              if (Object.keys(when).length) s.when = when;
              else delete s.when;
            })
          }
        >
          <option value="">any size</option>
          <option value="medium">medium work and up</option>
          <option value="large">large work</option>
        </select>
        <Input
          className="h-7 w-40 text-xs"
          placeholder="touches domain (optional)"
          value={step.when?.domain ?? ""}
          onChange={(e) =>
            onChange((s) => {
              const when = { ...(s.when ?? {}) };
              if (e.target.value.trim()) when.domain = e.target.value.trim();
              else delete when.domain;
              if (Object.keys(when).length) s.when = when;
              else delete s.when;
            })
          }
        />
      </div>
    </Card>
  );
}

function AgentsEditor({
  agents,
  onChange,
}: {
  agents: Agent[];
  onChange: (fn: (a: Agent[]) => void) => void;
}) {
  return (
    <div className="grid gap-2" data-testid="agents">
      {agents.map((a, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: names can repeat while being edited; position is the identity.
        <Card key={`${a.name}-${i}`} className="gap-2 px-3 py-2">
          <div className="flex flex-wrap items-center gap-2">
            <Input
              className="h-8 w-44"
              value={a.name}
              aria-label="Agent name"
              onChange={(e) =>
                onChange((list) => {
                  const x = list[i];
                  if (x) x.name = e.target.value;
                })
              }
            />
            <select
              className="h-8 rounded-md border bg-background px-2 text-sm"
              aria-label="Role"
              value={a.role}
              onChange={(e) =>
                onChange((list) => {
                  const x = list[i];
                  if (x) x.role = e.target.value;
                })
              }
            >
              {ROLES.map((r) => (
                <option key={r}>{r}</option>
              ))}
            </select>
            <Segmented
              options={["standard", "light"]}
              value={a.tier ?? "standard"}
              onChange={(v) =>
                onChange((list) => {
                  const x = list[i];
                  if (x) x.tier = v;
                })
              }
            />
            <span className="grow" />
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                onChange((list) => {
                  list.splice(i, 1);
                })
              }
            >
              Remove
            </Button>
          </div>
          <Textarea
            className={cn("min-h-14 text-sm")}
            placeholder="Standing instructions, added to every job this agent runs"
            value={a.instructions ?? ""}
            onChange={(e) =>
              onChange((list) => {
                const x = list[i];
                if (x) x.instructions = e.target.value;
              })
            }
          />
        </Card>
      ))}
      <div>
        <Button
          size="sm"
          variant="outline"
          data-testid="add-agent"
          onClick={() =>
            onChange((list) => {
              list.push({
                name: `Agent ${list.length + 1}`,
                role: "review",
                tier: "standard",
                instructions: "",
              });
            })
          }
        >
          + Add agent
        </Button>
      </div>
    </div>
  );
}

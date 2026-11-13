// A project's workflows and agents, edited in the app (ADR 0371, 0372, 0610; ported from sf-app's
// project workflows page). The skeleton (triage → spec → spec gate → build → verify → merge gate →
// merge queue) is fixed; a workflow fills its three slots with work steps (an agent, advisory) and
// gate steps (a person). Every control writes the config draft (config-editor.tsx); the save bar
// shows the engine's impact and saves the whole document with `config.save`.
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
import { ChevronDownIcon, ChevronUpIcon, LockIcon } from "lucide-react";
import type { ReactNode } from "react";
import { type ConfigEditor, type Doc, EditSection, Segmented } from "./config-editor.tsx";
import { Chip, Panel } from "./shell-list.tsx";

const ROLES = ["triage", "implement", "review", "summarise"] as const;
const SLOTS = [
  ["afterSpec", "After the spec", "Runs once, before the build"],
  ["beforeVerify", "Before verify", "After each build, on its branch"],
  ["afterVerify", "After verify", "Once verify passes, before the merge gate"],
] as const;
type Slot = (typeof SLOTS)[number][0];
export type Step = {
  id: string;
  kind: "work" | "gate";
  name: string;
  agent?: string;
  approver?: string;
  instructions?: string;
  when?: { sizeAtLeast?: string; domain?: string };
};
export type Agent = {
  name: string;
  role: string;
  tier?: string;
  instructions?: string;
  requires?: string[];
};
export type Workflow = {
  name: string;
  description?: string;
  slots?: Partial<Record<Slot, Step[]>>;
  core?: { build?: string };
};

const list = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
/** "" stands for "none" in a Select, which can't hold an empty value. */
const NONE = "__none";

function Pick({
  label,
  value,
  options,
  placeholder,
  className,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly (string | { value: string; label: string })[];
  placeholder?: string;
  className?: string;
  onChange: (v: string) => void;
}) {
  return (
    <Select value={value || NONE} onValueChange={(v) => onChange(v === NONE ? "" : v)}>
      <SelectTrigger size="sm" className={cn("w-[170px]", className)} aria-label={label}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {placeholder && (
          <SelectItem value={NONE} disabled>
            {placeholder}
          </SelectItem>
        )}
        {options.map((o) => {
          const v = typeof o === "string" ? o : o.value;
          return (
            <SelectItem key={v || NONE} value={v || NONE}>
              {typeof o === "string" ? o : o.label}
            </SelectItem>
          );
        })}
      </SelectContent>
    </Select>
  );
}

/** The workflows: a picker, then the chosen one's skeleton with its three slots. */
export function WorkflowsForm({
  editor,
  selected,
  onSelect,
}: {
  editor: ConfigEditor;
  selected: number;
  onSelect: (i: number) => void;
}) {
  const { doc, set } = editor;
  if (!doc) return null;
  const agents = list<Agent>(doc.agents);
  const workflows = list<Workflow>(doc.workflows);
  const index = Math.min(selected, Math.max(workflows.length - 1, 0));
  const wf = workflows[index];
  const setWorkflow = (fn: (w: Workflow) => void) =>
    set((d) => {
      const next = structuredClone(list<Workflow>(d.workflows));
      const target = next[index];
      if (target) fn(target);
      d.workflows = next;
    });
  return (
    <EditSection
      title="Workflows"
      note="Pick one to edit. With none, every item follows the skeleton alone. Workflows only add steps: the gates in the skeleton always run."
      testId="workflows-form"
    >
      <div className="flex flex-wrap items-center gap-1.5 py-2.5" data-testid="workflow-picker">
        {workflows.map((w, i) => (
          <Button
            // biome-ignore lint/suspicious/noArrayIndexKey: names can repeat while being edited; position is the identity.
            key={`${w.name}-${i}`}
            size="sm"
            variant={i === index ? "default" : "outline"}
            onClick={() => onSelect(i)}
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
              const all = list<Workflow>(d.workflows);
              d.workflows = [
                ...all,
                { name: `Workflow ${all.length + 1}`, description: "", slots: {}, core: {} },
              ];
            });
            onSelect(workflows.length);
          }}
        >
          New workflow
        </Button>
      </div>
      {wf && (
        <WorkflowEditor
          workflow={wf}
          agents={agents}
          onChange={setWorkflow}
          onRemove={() => {
            set((d) => {
              d.workflows = list<Workflow>(d.workflows).filter((_, i) => i !== index);
            });
            onSelect(0);
          }}
        />
      )}
    </EditSection>
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
      const steps = w.slots[slot] ?? [];
      const ids = new Set(Object.values(w.slots).flatMap((l) => (l ?? []).map((s) => s.id)));
      const stem = kind === "work" ? "review" : "sign-off";
      let id = stem;
      for (let n = 2; ids.has(id); n++) id = `${stem}-${n}`;
      steps.push(
        kind === "work"
          ? { id, kind, name: "Review", agent: reporters[0]?.name ?? "", instructions: "" }
          : { id, kind, name: "Sign-off", instructions: "" },
      );
      w.slots[slot] = steps;
    });
  const slot = (s: Slot) => (
    <SlotView
      slot={s}
      steps={slots[s] ?? []}
      agents={reporters}
      onAdd={addStep}
      onChange={onChange}
    />
  );
  return (
    <div
      className="flex flex-col gap-2 border-line-soft border-t py-2.5"
      data-testid="workflow-editor"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Input
          className="h-8 w-48"
          value={workflow.name}
          aria-label="Workflow name"
          onChange={(e) =>
            onChange((w) => {
              w.name = e.target.value;
            })
          }
        />
        <Input
          className="h-8 min-w-[200px] flex-1"
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
      <ol className="m-0 flex list-none flex-col gap-1.5 p-0" data-testid="skeleton">
        <Core name="Triage" detail="Sizes the item and picks this workflow" />
        <Core
          name="Spec and spec gate"
          detail="When the item is at least the project's spec size"
        />
        {slot("afterSpec")}
        <Core name="Build" detail="Role implement">
          <Pick
            label="Build agent"
            value={workflow.core?.build ?? ""}
            options={[{ value: "", label: "Default builder" }, ...builders.map((a) => a.name)]}
            onChange={(v) =>
              onChange((w) => {
                w.core = v ? { build: v } : {};
              })
            }
          />
        </Core>
        {slot("beforeVerify")}
        <Core name="Verify" detail="CI and the independent reviewer: set in code" />
        {slot("afterVerify")}
        <Core name="Merge gate" detail="Always a person" />
        <Core name="Merge queue" detail="Lands one at a time" />
      </ol>
    </div>
  );
}

function Core({ name, detail, children }: { name: string; detail: string; children?: ReactNode }) {
  return (
    <li className="flex flex-wrap items-center gap-2 rounded-lg bg-page px-3 py-2 shadow-ring">
      <LockIcon className="size-3.5 text-ink-muted" aria-hidden />
      <span className="font-medium text-[13px]">{name}</span>
      <span className="text-ink-3 text-xs">{detail}</span>
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
      const all = w.slots?.[slot];
      const j = i + by;
      if (!all || j < 0 || j >= all.length) return;
      [all[i], all[j]] = [all[j] as Step, all[i] as Step];
    });
  return (
    <li
      className="flex flex-col gap-2 rounded-lg border border-line border-dashed px-3 py-2"
      data-testid={`slot-${slot}`}
    >
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="font-medium">{meta?.[1]}</span>
        <span className="text-ink-3">{meta?.[2]}</span>
        <span className="grow" />
        <Button size="sm" variant="outline" className="h-7" onClick={() => onAdd(slot, "work")}>
          Add a work step
        </Button>
        <Button size="sm" variant="outline" className="h-7" onClick={() => onAdd(slot, "gate")}>
          Add a gate step
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
  const setWhen = (key: "sizeAtLeast" | "domain", v: string) =>
    onChange((s) => {
      const when = { ...(s.when ?? {}) };
      if (v) when[key] = v;
      else delete when[key];
      if (Object.keys(when).length) s.when = when;
      else delete s.when;
    });
  return (
    <Panel className="gap-2 px-3 py-2" data-testid={`step-${step.id}`}>
      <div className="flex flex-wrap items-center gap-2">
        <Chip tone={step.kind === "gate" ? "amber" : "neutral"}>
          {step.kind === "gate" ? "Gate · a person" : "Work · advisory"}
        </Chip>
        <Input
          className="h-8 w-44"
          value={step.name}
          aria-label="Step name"
          onChange={(e) =>
            onChange((s) => {
              s.name = e.target.value;
            })
          }
        />
        <span className="font-mono text-ink-muted text-xs">{step.id}</span>
        {step.kind === "work" ? (
          <Pick
            label="Agent"
            placeholder="Pick an agent"
            value={step.agent ?? ""}
            options={agents.map((a) => a.name)}
            onChange={(v) =>
              onChange((s) => {
                s.agent = v;
              })
            }
          />
        ) : (
          <Input
            className="h-8 w-48"
            placeholder="Approver login (or approvers)"
            aria-label="Approver"
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
          size="icon"
          variant="ghost"
          className="size-7"
          aria-label={`Move ${step.name} up`}
          onClick={() => onMove(-1)}
        >
          <ChevronUpIcon />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="size-7"
          aria-label={`Move ${step.name} down`}
          onClick={() => onMove(1)}
        >
          <ChevronDownIcon />
        </Button>
        <Button size="sm" variant="ghost" className="h-7" onClick={onRemove}>
          Remove
        </Button>
      </div>
      <Textarea
        className="min-h-16 text-[13px]"
        aria-label={`${step.name} instructions`}
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
        <span className="text-ink-3">Only when</span>
        <Pick
          label="Size at least"
          value={step.when?.sizeAtLeast ?? ""}
          options={[
            { value: "", label: "Any size" },
            { value: "medium", label: "Medium work and up" },
            { value: "large", label: "Large work" },
          ]}
          onChange={(v) => setWhen("sizeAtLeast", v)}
        />
        <Input
          className="h-8 w-44 text-xs"
          placeholder="Touches domain (optional)"
          aria-label="Touches domain"
          value={step.when?.domain ?? ""}
          onChange={(e) => setWhen("domain", e.target.value.trim())}
        />
      </div>
    </Panel>
  );
}

/** The project's agents: profiles steps hand to, each a model role and tier, never a model. */
export function AgentsForm({ editor }: { editor: ConfigEditor }) {
  const { doc, set } = editor;
  if (!doc) return null;
  const agents = list<Agent>(doc.agents);
  const edit = (fn: (a: Agent[]) => void) =>
    set((d: Doc) => {
      const next = structuredClone(list<Agent>(d.agents));
      fn(next);
      d.agents = next;
    });
  return (
    <EditSection
      title="Agents"
      note="An agent names a model role and tier, never a model: the runner that takes the job picks the model, on its owner's subscription."
      testId="agents-form"
    >
      {agents.map((a, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: names can repeat while being edited; position is the identity.
          key={`${a.name}-${i}`}
          className="flex flex-col gap-2 border-line-soft border-b py-2.5 last:border-b-0"
          data-testid={`agent-${i}`}
        >
          <div className="flex flex-wrap items-center gap-2">
            <Input
              className="h-8 w-44"
              value={a.name}
              aria-label="Agent name"
              onChange={(e) =>
                edit((all) => {
                  const x = all[i];
                  if (x) x.name = e.target.value;
                })
              }
            />
            <Pick
              label="Role"
              value={a.role}
              options={ROLES}
              onChange={(v) =>
                edit((all) => {
                  const x = all[i];
                  if (x) x.role = v;
                })
              }
            />
            <Segmented
              label="Tier"
              options={["standard", "light"]}
              value={a.tier ?? "standard"}
              onChange={(v) =>
                edit((all) => {
                  const x = all[i];
                  if (x) x.tier = v;
                })
              }
            />
            <span className="grow" />
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                edit((all) => {
                  all.splice(i, 1);
                })
              }
            >
              Remove
            </Button>
          </div>
          <Textarea
            className="min-h-16 text-[13px]"
            aria-label={`${a.name} instructions`}
            placeholder="Standing instructions, added to every job this agent runs"
            value={a.instructions ?? ""}
            onChange={(e) =>
              edit((all) => {
                const x = all[i];
                if (x) x.instructions = e.target.value;
              })
            }
          />
        </div>
      ))}
      <div className="py-2.5">
        <Button
          size="sm"
          variant="outline"
          data-testid="add-agent"
          onClick={() =>
            edit((all) => {
              all.push({
                name: `Agent ${all.length + 1}`,
                role: "review",
                tier: "standard",
                instructions: "",
              });
            })
          }
        >
          Add an agent
        </Button>
      </div>
    </EditSection>
  );
}

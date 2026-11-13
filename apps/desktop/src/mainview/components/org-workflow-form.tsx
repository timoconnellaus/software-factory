// An org workflow, edited in the app (spec 52, ADR 0516, 0610): its name and description, then its
// stages in order, each an instance of a stage type with a name, a phase, an optional org agent, an
// optional "only when", and the type's settings (JSON, defaults from `stageType.list`). The draft is
// checked by `workflow.preview` once typing stops (every broken rule, and the impact against the
// saved version); saving is `workflow.save` through `decide()` (Touch ID), and a save that loosens
// waits for an org admin. Nothing here judges the change: the classification is the engine's.
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
import { ChevronDownIcon, ChevronUpIcon } from "lucide-react";
import { useState } from "react";
import { stageTypesQuery } from "../lib/factory-queries.ts";
import { read } from "../lib/op.ts";
import { workflowDiff } from "../lib/org-diff.ts";
import { usePolicyDecide } from "../lib/policy-decide.ts";
import { useCanDecide } from "./cannot-approve.tsx";
import {
  CharCount,
  EditField,
  EditSection,
  ImpactList,
  LeaveGuard,
  PREVIEW_DEBOUNCE_MS,
  saveLabel,
  useDebounced,
} from "./config-editor.tsx";
import { DiffRows } from "./diff-rows.tsx";
import { Chip, Panel } from "./shell-list.tsx";

export type Stage = {
  id: string;
  type: string;
  typeVersion: number;
  name: string;
  phase: "shaping" | "delivery";
  settings?: unknown;
  when?: { sizeAtLeast?: string; domain?: string };
  agent?: string;
};
export type OrgWorkflow = {
  schema: 1;
  id: string;
  name: string;
  description?: string;
  template?: { id: string; version: number };
  stages: Stage[];
};

const NONE = "__none";

function Pick({
  label,
  value,
  options,
  className = "w-[150px]",
  onChange,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  className?: string;
  onChange: (v: string) => void;
}) {
  return (
    <Select value={value || NONE} onValueChange={(v) => onChange(v === NONE ? "" : v)}>
      <SelectTrigger size="sm" className={className} aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value || NONE} value={o.value || NONE}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** A stage id new to the workflow, from its type: `build`, then `build_2`… */
export function newStageId(type: string, taken: string[]): string {
  const stem = type.replace(/[^a-z0-9]+/g, "_");
  let id = stem;
  for (let n = 2; taken.includes(id); n++) id = `${stem}_${n}`;
  return id;
}

export function OrgWorkflowForm({
  orgId,
  baseVersion,
  saved,
  agents,
  onDone,
}: {
  orgId: string;
  baseVersion: number;
  saved: OrgWorkflow;
  agents: string[];
  onDone: () => void;
}) {
  const [draft, setDraft] = useState<OrgWorkflow>(() => structuredClone(saved));
  // The version the draft was made from. When the saved workflow moves underneath it, the draft is
  // kept and the person reviews the difference against the new version before saving.
  const [draftBase, setDraftBase] = useState(baseVersion);
  const [savedBase, setSavedBase] = useState<OrgWorkflow>(() => structuredClone(saved));
  const [note, setNote] = useState("");
  const [open, setOpen] = useState(false);
  const types = useQuery(stageTypesQuery());
  const { run, pending } = usePolicyDecide();
  const canDecide = useCanDecide();
  const edited = JSON.stringify(draft) !== JSON.stringify(savedBase);
  const moved = draftBase !== baseVersion;
  // Nothing edited yet: just follow the saved version.
  if (moved && !edited) {
    setDraft(structuredClone(saved));
    setSavedBase(structuredClone(saved));
    setDraftBase(baseVersion);
  }
  const dirty = edited || JSON.stringify(draft) !== JSON.stringify(saved);
  const discard = () => {
    setDraft(structuredClone(saved));
    setSavedBase(structuredClone(saved));
    setDraftBase(baseVersion);
  };
  // Checked once typing stops (Cloudflare cost: a preview is a Worker request and D1 reads).
  const settled = useDebounced(draft, PREVIEW_DEBOUNCE_MS);
  const typing = JSON.stringify(settled) !== JSON.stringify(draft);
  const preview = useQuery({
    queryKey: ["workflow", orgId, "preview", baseVersion, settled],
    queryFn: () => read("workflow.preview", { orgId, workflow: settled as never }),
    enabled: dirty && !typing,
  });
  const fresh =
    !typing && preview.data && !preview.isFetching && preview.data.currentVersion === draftBase
      ? preview.data
      : null;
  const loosens = fresh?.impact?.class === "loosens";
  const edit = (fn: (w: OrgWorkflow) => void) =>
    setDraft((prev) => {
      const next = structuredClone(prev);
      fn(next);
      return next;
    });
  const stage = (i: number, fn: (s: Stage) => void) =>
    edit((w) => {
      const s = w.stages[i];
      if (s) fn(s);
    });
  const move = (i: number, by: -1 | 1) =>
    edit((w) => {
      const j = i + by;
      if (j < 0 || j >= w.stages.length) return;
      [w.stages[i], w.stages[j]] = [w.stages[j] as Stage, w.stages[i] as Stage];
    });
  const [adding, setAdding] = useState("");
  const typeList = types.data?.types ?? [];
  const errorsFor = (stageId: string | null) =>
    (fresh?.errors ?? []).filter((e) => e.stageId === stageId);

  return (
    <div className="flex flex-col gap-4" data-testid="org-workflow-form">
      <LeaveGuard dirty={dirty} />
      <EditSection title="Workflow">
        <EditField label="Name">
          <Input
            className="h-8 w-full max-w-56"
            aria-label="Workflow name"
            value={draft.name}
            onChange={(e) =>
              edit((w) => {
                w.name = e.target.value;
              })
            }
          />
        </EditField>
        <EditField label="What it is for" help="Shown when a project picks a workflow.">
          <Input
            className="h-8 w-full max-w-72"
            aria-label="Workflow description"
            value={draft.description ?? ""}
            onChange={(e) =>
              edit((w) => {
                w.description = e.target.value;
              })
            }
          />
        </EditField>
      </EditSection>

      <EditSection
        title="Stages"
        note="In order. A stage is an instance of a stage type; gates and checks come from the type."
        testId="org-stages"
      >
        {draft.stages.map((s, i) => {
          const type = typeList.find((t) => t.id === s.type);
          const errors = errorsFor(s.id);
          const settings = JSON.stringify(s.settings ?? {}, null, 2);
          return (
            <div
              key={s.id}
              className="flex flex-col gap-2 border-line-soft border-b py-2.5 last:border-b-0"
              data-testid={`org-stage-${s.id}`}
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-ink-muted text-xs">{i + 1}</span>
                <Input
                  className="h-8 w-44"
                  aria-label="Stage name"
                  value={s.name}
                  onChange={(e) =>
                    stage(i, (x) => {
                      x.name = e.target.value;
                    })
                  }
                />
                <Chip tone={type?.gate ? "amber" : "neutral"}>
                  {type?.name ?? s.type}
                  {type?.gate ? " · a person decides" : ""}
                </Chip>
                <Pick
                  label="Phase"
                  className="w-[120px]"
                  value={s.phase}
                  options={(type?.phases ?? [s.phase]).map((p) => ({ value: p, label: p }))}
                  onChange={(v) =>
                    stage(i, (x) => {
                      x.phase = v as Stage["phase"];
                    })
                  }
                />
                <Pick
                  label="Agent"
                  value={s.agent ?? ""}
                  options={[
                    { value: "", label: "The type's agent" },
                    ...agents.map((a) => ({ value: a, label: a })),
                  ]}
                  onChange={(v) =>
                    stage(i, (x) => {
                      if (v) x.agent = v;
                      else delete x.agent;
                    })
                  }
                />
              </div>
              <SettingsBox
                key={s.id}
                initial={settings}
                onApply={(v) =>
                  stage(i, (x) => {
                    x.settings = v;
                  })
                }
              >
                <span className="grow" />
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-7"
                  aria-label={`Move ${s.name} up`}
                  onClick={() => move(i, -1)}
                >
                  <ChevronUpIcon />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-7"
                  aria-label={`Move ${s.name} down`}
                  onClick={() => move(i, 1)}
                >
                  <ChevronDownIcon />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7"
                  data-testid="remove-stage"
                  onClick={() =>
                    edit((w) => {
                      w.stages.splice(i, 1);
                    })
                  }
                >
                  Remove
                </Button>
              </SettingsBox>
              {errors.map((e) => (
                <div key={`${e.rule}-${e.message}`} className="text-chip-amber-ink text-xs">
                  {e.rule}: {e.message}
                </div>
              ))}
            </div>
          );
        })}
        <div className="flex flex-wrap items-center gap-2 py-2.5">
          <Pick
            label="Stage type to add"
            className="w-[200px]"
            value={adding}
            options={[
              { value: "", label: "Choose a stage type" },
              ...typeList.map((t) => ({ value: t.id, label: t.name })),
            ]}
            onChange={setAdding}
          />
          <Button
            size="sm"
            variant="outline"
            disabled={!adding}
            onClick={() => {
              const t = typeList.find((x) => x.id === adding);
              if (!t) return;
              edit((w) => {
                w.stages.push({
                  id: newStageId(
                    t.id,
                    w.stages.map((x) => x.id),
                  ),
                  type: t.id,
                  typeVersion: t.version,
                  name: t.name,
                  phase: (t.phases[0] ?? "delivery") as Stage["phase"],
                  settings: t.defaults,
                });
              });
              setAdding("");
            }}
          >
            Add a stage
          </Button>
        </div>
      </EditSection>

      {dirty && (
        <Panel
          needsYou
          className="sticky bottom-3 z-10 gap-2.5 shadow-lg"
          data-testid="org-save-bar"
        >
          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-2 min-[900px]:gap-2">
            <span className="font-semibold text-[13px] max-[899px]:hidden">Unsaved changes</span>
            {loosens && (
              <Chip tone="amber">
                Loosens<span className="max-[899px]:hidden">: an org admin approves</span>
              </Chip>
            )}
            {fresh && !fresh.valid && <Chip tone="amber">Not valid</Chip>}
            {!fresh && <span className="text-ink-3 text-xs">Checking…</span>}
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 underline min-[900px]:hidden"
              aria-expanded={open}
              onClick={() => setOpen((o) => !o)}
            >
              {open ? "Hide" : "Details"}
            </Button>
            <span className="grow" />
            <Button size="sm" variant="ghost" className="px-2 max-[899px]:hidden" onClick={discard}>
              Discard
            </Button>
            <Button
              size="sm"
              disabled={!fresh?.valid || pending !== null || !canDecide || moved}
              data-testid="org-save"
              onClick={async () => {
                const out = await run(
                  "workflow.save",
                  { orgId, baseVersion: draftBase, workflow: draft, ...(note ? { note } : {}) },
                  "Saved",
                );
                if (out) onDone();
              }}
            >
              {saveLabel(loosens, baseVersion).short}
              {loosens && <span className="max-[899px]:hidden"> for approval</span>}
            </Button>
          </div>
          {moved && (
            <div className="flex flex-wrap items-center gap-2 text-[13px]" data-testid="org-moved">
              <span className="min-w-[min(100%,280px)] basis-full">
                The workflow changed while you were editing (v{draftBase} → v{baseVersion}). What
                the other change did, which keeping yours on v{baseVersion} replaces:
              </span>
              <div className="basis-full">
                <DiffRows rows={workflowDiff(savedBase, saved)} testId="org-moved-diff" />
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setSavedBase(structuredClone(saved));
                  setDraftBase(baseVersion);
                }}
              >
                Keep my changes on v{baseVersion}
              </Button>
            </div>
          )}
          <div className={cn("flex flex-col gap-2", !open && !moved && "max-[899px]:hidden")}>
            {fresh && !fresh.valid && (
              <ul className="m-0 list-none p-0 text-[13px]">
                {fresh.errors.map((e) => (
                  <li key={`${e.rule}-${e.stageId}-${e.message}`}>
                    {e.rule}
                    {e.stageId ? ` (${e.stageId})` : ""}: {e.message}
                  </li>
                ))}
              </ul>
            )}
            {fresh?.impact && <ImpactList changes={fresh.impact.changes} testId="org-impact" />}
            <Input
              placeholder="Why (optional, shows in History)"
              aria-label="Why"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
            <Button
              size="sm"
              variant="outline"
              className="w-fit min-[900px]:hidden"
              onClick={discard}
            >
              Discard changes
            </Button>
          </div>
        </Panel>
      )}
    </div>
  );
}

/** A stage's settings as JSON: edited as text, applied to the draft when it parses. */
function SettingsBox({
  initial,
  onApply,
  children,
}: {
  initial: string;
  onApply: (v: unknown) => void;
  /** The stage's move and remove controls, on the counter's line. */
  children?: React.ReactNode;
}) {
  const [text, setText] = useState(initial);
  let bad = false;
  try {
    JSON.parse(text);
  } catch {
    bad = true;
  }
  return (
    <div className="flex flex-col gap-1">
      <Textarea
        className="min-h-16 font-mono text-xs"
        aria-label="Stage settings (JSON)"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          try {
            onApply(JSON.parse(e.target.value));
          } catch {
            // Applied once it parses again.
          }
        }}
      />
      <div className="flex items-center gap-2 text-[11px]">
        {bad && <span className="text-chip-amber-ink">Not valid JSON yet: not applied.</span>}
        <CharCount value={text} max={16_000} />
        {children}
      </div>
    </div>
  );
}

// The Policy page's edit mode (ADR 0370, 0610; ported from sf-app's project settings): a form over
// the draft, section by section, then Edit as JSON for the whole document. Every control writes the
// draft only; the save bar (config-editor.tsx) shows the engine's impact and saves. The factory's
// changes (trials) and History act at once: a stop, a revert or a rollback that loosens comes back
// `pending` and waits for an approver like any save.
import { ago } from "@software-factory/client/format";
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
import { RadioGroup, RadioGroupItem } from "@software-factory/ui/components/radio-group";
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
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import {
  adjudicatorQuery,
  orgWorkflowOf,
  orgWorkflowQuery,
  trialsQuery,
} from "../lib/factory-queries.ts";
import { OpError, op, read, submitKey } from "../lib/op.ts";
import { usePolicyDecide } from "../lib/policy-decide.ts";
import { useCanDecide } from "./cannot-approve.tsx";
import {
  ChangeDiff,
  type ConfigEditor,
  changedPaths,
  type Doc,
  EditField,
  EditSection,
  ImpactChip,
  ImpactList,
  ListEditor,
  NumberInput,
  num,
  obj,
  Segmented,
  shown,
  strs,
} from "./config-editor.tsx";
import { Chip } from "./shell-list.tsx";

/** Deep equality for setting values (JSON). */
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

type Overrides = Record<string, Record<string, string>>;

const AUTONOMY = [
  {
    key: "cautious",
    title: "Cautious",
    text: "A person approves every spec and every write an agent makes.",
  },
  {
    key: "balanced",
    title: "Balanced",
    text: "Agents write; specs from medium work up, spending and reaching outside need a person.",
  },
  {
    key: "autonomous",
    title: "Autonomous",
    text: "Agents may also spend and reach outside. Merge, deploy and self-modify still go to a person.",
  },
] as const;
const ACTORS = ["agent", "runner", "intake", "self-improve"] as const;
const RISKS = [
  "read",
  "write",
  "plan",
  "spend",
  "outbound",
  "merge",
  "deploy",
  "self-modify",
] as const;
const LOCKED_RISKS = new Set(["merge", "deploy", "self-modify"]);
const SECTIONS = [
  ["verdict", "Verdict row", "Checks, criteria, holdouts, reviewer verdict and risk at a glance"],
  ["changed", "What changed", "The agent's summary of the change"],
  ["criteria", "Acceptance criteria", "Each criterion with its evidence"],
  ["holdout", "Holdout tests", "Tests the builder never saw, and their results"],
  ["reviewer", "Reviewer notes", "The independent reviewer (a different model role)"],
  ["visual", "Visual evidence", "Screenshots from the run"],
  ["risk", "Risk flags", "For example: touches .factory/, widens permissions"],
  ["diff", "Inline diff", "Collapsed until opened"],
] as const;
const ALL_SECTIONS: string[] = SECTIONS.map((s) => s[0]);

/** Rollbacks and the factory's own changes: they act at once, or wait when they loosen. */
async function act(editor: ConfigEditor, fn: () => Promise<unknown>, done: string) {
  editor.setBusy(true);
  try {
    await fn();
    toast.success(done);
  } catch (error) {
    if (error instanceof OpError && error.code === "pending") {
      toast.success("This loosens the config, so it waits for an approver.");
    } else toast.error(error instanceof Error ? error.message : String(error));
  } finally {
    editor.setBusy(false);
    await editor.refresh();
  }
}

export function PolicyForm({ editor, orgId }: { editor: ConfigEditor; orgId: string | null }) {
  const { doc, current, set } = editor;
  const [json, setJson] = useState<string | null>(null);
  const org = useOrgWorkflow(orgId, doc);
  if (!doc) return null;
  const overrides = obj(doc.overrides) as Overrides;
  const sections = Array.isArray(obj(doc.reviewPacket).sections)
    ? strs(obj(doc.reviewPacket).sections)
    : ALL_SECTIONS.slice();
  const changed = changedPaths(editor);
  return (
    <div className="flex flex-col gap-4" data-testid="policy-form">
      <div className="flex flex-wrap items-center gap-2 text-ink-3 text-xs">
        <span className="min-w-[min(100%,320px)] flex-1">
          Saving makes a new version. New work uses it straight away; running work keeps the
          stricter of its own version and the new one.
        </span>
        <Button
          size="sm"
          variant="outline"
          onClick={() => setJson(JSON.stringify(doc, null, 2))}
          data-testid="edit-json"
        >
          Edit as JSON
        </Button>
      </div>

      {json !== null && (
        <EditSection title="Edit as JSON" note="Apply puts it in the form; nothing is saved yet.">
          <div className="flex flex-col gap-2 py-2.5">
            <Textarea
              className="min-h-72 font-mono text-xs"
              value={json}
              aria-label="The config as JSON"
              onChange={(e) => setJson(e.target.value)}
              data-testid="config-json"
            />
            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={() => {
                  try {
                    editor.setDraft(JSON.parse(json) as Doc);
                    setJson(null);
                  } catch {
                    toast.error("That isn't valid JSON.");
                  }
                }}
              >
                Apply
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setJson(null)}>
                Close
              </Button>
            </div>
          </div>
        </EditSection>
      )}

      <EditSection
        title="Autonomy"
        note="Merge, deploy and self-modify always go to a person."
        changed={changed.has("autonomyPolicy") || changed.has("overrides")}
        testId="edit-autonomy"
      >
        <RadioGroup
          className="grid gap-2 py-2.5 min-[900px]:grid-cols-3"
          aria-label="Autonomy policy"
          value={typeof doc.autonomyPolicy === "string" ? doc.autonomyPolicy : ""}
          onValueChange={(v) =>
            set((d) => {
              d.autonomyPolicy = v;
            })
          }
        >
          {AUTONOMY.map((a) => (
            // biome-ignore lint/a11y/noLabelWithoutControl: the radio item inside is the control.
            <label
              key={a.key}
              className={cn(
                "flex cursor-pointer items-start gap-2.5 rounded-lg px-3 py-2.5 shadow-ring",
                doc.autonomyPolicy === a.key && "ring-[1.5px] ring-primary",
              )}
            >
              <RadioGroupItem value={a.key} className="mt-0.5" aria-label={a.title} />
              <span className="flex flex-col gap-0.5">
                <span className="font-semibold text-[13px]">
                  {a.title}
                  {current?.policy?.autonomyPolicy === a.key && (
                    <span className="ml-2 font-normal text-ink-muted text-xs">current</span>
                  )}
                </span>
                <span className="text-ink-3 text-xs">{a.text}</span>
              </span>
            </label>
          ))}
        </RadioGroup>
        <OverridesEditor
          overrides={overrides}
          onChange={(next) =>
            set((d) => {
              d.overrides = next;
            })
          }
        />
      </EditSection>

      <EditSection
        title="Timeouts and people"
        changed={changed.has("timeouts") || changed.has("approvers") || changed.has("backupOwner")}
      >
        <EditField
          label="Gate timeout"
          help="Hours a gate waits before it goes to the backup owner. Never auto-accepted."
        >
          <NumberInput
            label="Gate timeout"
            value={num(obj(doc.timeouts).gateHours, 72)}
            min={1}
            max={1440}
            suffix="hours"
            onChange={(v) =>
              set((d) => {
                d.timeouts = { ...obj(d.timeouts), gateHours: v };
              })
            }
          />
        </EditField>
        <EditField
          label="Question timeout"
          help="Hours an agent's question waits before it goes to the backup owner."
        >
          <NumberInput
            label="Question timeout"
            value={num(obj(doc.timeouts).questionHours, 48)}
            min={1}
            max={1440}
            suffix="hours"
            onChange={(v) =>
              set((d) => {
                d.timeouts = { ...obj(d.timeouts), questionHours: v };
              })
            }
          />
        </EditField>
        <EditField
          label="Approvers"
          help="GitHub logins who decide gates. Empty means the org's owners and admins."
        >
          <ListEditor
            items={strs(doc.approvers)}
            placeholder="GitHub login"
            testId="approvers"
            onChange={(next) =>
              set((d) => {
                d.approvers = next;
              })
            }
          />
        </EditField>
        <EditField
          label="Backup owner"
          help="Gets a gate or question that timed out. Empty means the first approver."
        >
          <Input
            className="h-8 w-48"
            aria-label="Backup owner"
            value={typeof doc.backupOwner === "string" ? doc.backupOwner : ""}
            placeholder="GitHub login"
            onChange={(e) =>
              set((d) => {
                if (e.target.value.trim()) d.backupOwner = e.target.value.trim();
                else delete d.backupOwner;
              })
            }
          />
        </EditField>
      </EditSection>

      <EditSection
        title="Spec approval"
        changed={changed.has("spec") || changed.has("workflowOverrides")}
      >
        {org.on ? (
          <OverrideField
            org={org}
            setting={REQUIRED_FROM}
            label="Needed from"
            help="Items this size and up get a spec a person approves; smaller ones skip Plan."
            editor={editor}
            render={(value, put) => (
              <Segmented
                label="Spec needed from"
                options={SIZES}
                value={typeof value === "string" ? value : "medium"}
                onChange={put}
              />
            )}
          />
        ) : (
          <EditField
            label="Needed from"
            help="Items this size and up get a spec a person approves; smaller ones skip Plan."
          >
            <Segmented
              label="Spec needed from"
              options={SIZES}
              value={
                typeof obj(doc.spec).requiredFrom === "string"
                  ? (obj(doc.spec).requiredFrom as string)
                  : "medium"
              }
              onChange={(v) =>
                set((d) => {
                  d.spec = { ...obj(d.spec), requiredFrom: v };
                })
              }
            />
          </EditField>
        )}
      </EditSection>

      <EditSection
        title="Throughput"
        changed={changed.has("wipLimit") || changed.has("retryLimit")}
      >
        <EditField
          label="WIP limit"
          help="How many items may wait at your gates before new builds stop."
        >
          <NumberInput
            label="WIP limit"
            value={num(doc.wipLimit, 5)}
            min={1}
            max={100}
            suffix="items"
            testId="wip-limit"
            onChange={(v) =>
              set((d) => {
                d.wipLimit = v;
              })
            }
          />
        </EditField>
        {org.on ? (
          <OverrideField
            org={org}
            setting={RETRY}
            label="Retry limit"
            help="Automatic retries of a failed build or verify (0–5)."
            editor={editor}
            render={(value, put) => (
              <NumberInput
                label="Retry limit"
                value={num(value, 2)}
                min={0}
                max={5}
                onChange={put}
              />
            )}
          />
        ) : (
          <EditField
            label="Retry limit"
            help="Automatic retries of a failed build or verify (0–5)."
          >
            <NumberInput
              label="Retry limit"
              value={num(doc.retryLimit, 2)}
              min={0}
              max={5}
              onChange={(v) =>
                set((d) => {
                  d.retryLimit = v;
                })
              }
            />
          </EditField>
        )}
      </EditSection>

      <EditSection
        title="Review packet"
        note="Which sections show at the merge gate, and in what order."
        changed={changed.has("reviewPacket")}
      >
        {org.on ? (
          <OverrideField
            org={org}
            setting={SECTIONS_SETTING}
            label="Sections"
            help="The org's workflow sets them; this project may show more."
            editor={editor}
            block
            render={(value, put) => (
              <PacketEditor
                sections={Array.isArray(value) ? strs(value) : ALL_SECTIONS.slice()}
                onChange={put}
              />
            )}
          />
        ) : (
          <PacketEditor
            sections={sections}
            onChange={(next) =>
              set((d) => {
                d.reviewPacket = { sections: next };
              })
            }
          />
        )}
      </EditSection>

      <EditSection title="Protection on the default branch" changed={changed.has("protection")}>
        <EditField
          label="When protection is red"
          help="Block keeps builds queued until the branch's rulesets are fixed."
        >
          <Segmented
            label="When protection is red"
            options={["warn", "block"]}
            value={(obj(doc.protection).onRed as string) ?? "warn"}
            onChange={(v) =>
              set((d) => {
                d.protection = { ...obj(d.protection), onRed: v };
              })
            }
          />
        </EditField>
        {org.on ? (
          <OverrideField
            org={org}
            setting={CHECKS}
            label="Required CI checks"
            help="Besides factory/verify. Goes into the generated ruleset."
            editor={editor}
            render={(value, put) => (
              <ListEditor items={strs(value)} placeholder="check name" onChange={put} />
            )}
          />
        ) : (
          <EditField
            label="Required CI checks"
            help="Besides factory/verify. Goes into the generated ruleset."
          >
            <ListEditor
              items={
                Array.isArray(obj(doc.protection).requiredChecks)
                  ? strs(obj(doc.protection).requiredChecks)
                  : ["ci"]
              }
              placeholder="check name"
              onChange={(next) =>
                set((d) => {
                  d.protection = { ...obj(d.protection), requiredChecks: next };
                })
              }
            />
          </EditField>
        )}
      </EditSection>

      <EditSection
        title="Self-improvement"
        note="The factory trials practice changes on the next few items and keeps them only if those items do at least as well. Policy never changes this way."
        changed={changed.has("improve")}
      >
        <EditField
          label="Let the factory improve its practice"
          help="Turning it on loosens the config: it waits for an approver."
        >
          <Segmented
            label="Let the factory improve its practice"
            options={["off", "on"]}
            value={obj(doc.improve).enabled === true ? "on" : "off"}
            onChange={(v) =>
              set((d) => {
                d.improve = { ...obj(d.improve), enabled: v === "on" };
              })
            }
          />
        </EditField>
        <EditField label="Trial size" help="How many items a change is tried on (3–20).">
          <NumberInput
            label="Trial size"
            value={num(obj(doc.improve).trialSize, 5)}
            min={3}
            max={20}
            suffix="items"
            onChange={(v) =>
              set((d) => {
                d.improve = { ...obj(d.improve), trialSize: v };
              })
            }
          />
        </EditField>
        <EditField label="Weekly cap" help="At most this many changes a week (1–10).">
          <NumberInput
            label="Weekly cap"
            value={num(obj(doc.improve).weeklyCap, 3)}
            min={1}
            max={10}
            suffix="changes"
            onChange={(v) =>
              set((d) => {
                d.improve = { ...obj(d.improve), weeklyCap: v };
              })
            }
          />
        </EditField>
        <Trials editor={editor} />
      </EditSection>

      <EditSection
        title="Adjudicator"
        note="Says how it would decide your spec gates and gate steps. It can go active for a kind once 20 of its verdicts match yours 95% of the time; never merge, deploy or self-modify."
        changed={changed.has("adjudicator")}
      >
        <AdjudicatorModes
          projectId={editor.projectId}
          modes={obj(doc.adjudicator)}
          onChange={(kind, mode) =>
            set((d) => {
              d.adjudicator = { ...obj(d.adjudicator), [kind]: mode };
            })
          }
        />
      </EditSection>
    </div>
  );
}

function OverridesEditor({
  overrides,
  onChange,
}: {
  overrides: Overrides;
  onChange: (next: Overrides) => void;
}) {
  const rows = Object.entries(overrides).flatMap(([actor, risks]) =>
    Object.entries(risks ?? {}).map(([risk, decision]) => ({ actor, risk, decision })),
  );
  const [actor, setActor] = useState<string>("agent");
  const [risk, setRisk] = useState<string>("outbound");
  const [decision, setDecision] = useState<string>("allow");
  const put = (a: string, r: string, d: string | null) => {
    const next = structuredClone(overrides);
    if (d === null) {
      delete next[a]?.[r];
      if (next[a] && Object.keys(next[a]).length === 0) delete next[a];
    } else next[a] = { ...(next[a] ?? {}), [r]: d };
    onChange(next);
  };
  return (
    <div className="flex flex-col gap-2 border-line-soft border-t py-2.5" data-testid="overrides">
      <div className="font-medium text-[13px]">
        Overrides ({rows.length}){" "}
        <span className="font-normal text-ink-3 text-xs">
          per actor and risk class, on top of the autonomy policy
        </span>
      </div>
      {rows.map((r) => (
        <div key={`${r.actor}.${r.risk}`} className="flex flex-wrap items-center gap-2 text-xs">
          <span className="w-24">{r.actor}</span>
          <span className="w-24 font-mono">{r.risk}</span>
          <Segmented
            label={`${r.actor} ${r.risk}`}
            options={["allow", "review", "deny"]}
            value={r.decision}
            onChange={(d) => put(r.actor, r.risk, d)}
          />
          <Button size="sm" variant="ghost" onClick={() => put(r.actor, r.risk, null)}>
            Remove
          </Button>
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-2">
        <Pick label="Actor" value={actor} options={ACTORS} onChange={setActor} />
        <Pick
          label="Risk class"
          value={risk}
          options={RISKS}
          locked={LOCKED_RISKS}
          onChange={setRisk}
        />
        <Pick
          label="Decision"
          value={decision}
          options={["allow", "review", "deny"]}
          onChange={setDecision}
        />
        <Button size="sm" variant="outline" onClick={() => put(actor, risk, decision)}>
          Add override
        </Button>
      </div>
    </div>
  );
}

function Pick({
  label,
  value,
  options,
  locked,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly string[];
  locked?: Set<string>;
  onChange: (v: string) => void;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger size="sm" className="w-[150px]" aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o} value={o} disabled={locked?.has(o)}>
            {locked?.has(o) ? `${o} (always a person)` : o}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function PacketEditor({
  sections,
  onChange,
}: {
  sections: string[];
  onChange: (next: string[]) => void;
}) {
  // The shown sections in their order, then the hidden ones.
  const shown = sections.filter((s) => ALL_SECTIONS.includes(s));
  const order = [...shown, ...ALL_SECTIONS.filter((s) => !shown.includes(s))];
  const move = (key: string, by: -1 | 1) => {
    const i = shown.indexOf(key);
    const j = i + by;
    if (i < 0 || j < 0 || j >= shown.length) return;
    const next = [...shown];
    [next[i], next[j]] = [next[j] as string, next[i] as string];
    onChange(next);
  };
  return (
    <ul className="m-0 flex list-none flex-col p-0" data-testid="packet-sections">
      {order.map((key) => {
        const meta = SECTIONS.find((s) => s[0] === key);
        const on = shown.includes(key);
        return (
          <li
            key={key}
            className="flex items-center gap-2 border-line-soft border-b py-2 last:border-b-0"
          >
            <div className="flex flex-col">
              <Button
                size="icon"
                variant="ghost"
                className="size-5"
                aria-label={`Move ${meta?.[1]} up`}
                disabled={!on}
                onClick={() => move(key, -1)}
              >
                <ChevronUpIcon />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                className="size-5"
                aria-label={`Move ${meta?.[1]} down`}
                disabled={!on}
                onClick={() => move(key, 1)}
              >
                <ChevronDownIcon />
              </Button>
            </div>
            <div className={cn("min-w-0 grow", !on && "opacity-50")}>
              <div className="font-medium text-[13px]">{meta?.[1]}</div>
              <div className="text-ink-3 text-xs">{meta?.[2]}</div>
            </div>
            <Segmented
              label={`Show ${meta?.[1]}`}
              options={["show", "hide"]}
              value={on ? "show" : "hide"}
              onChange={(v) =>
                onChange(v === "show" ? [...shown, key] : shown.filter((s) => s !== key))
              }
            />
          </li>
        );
      })}
    </ul>
  );
}

/** The factory's own changes (ADR 0373): each trial, what decided it, and a revert. */
function Trials({ editor }: { editor: ConfigEditor }) {
  const { projectId, currentVersion, busy } = editor;
  const trials = useQuery(trialsQuery(projectId));
  const list = trials.data?.trials ?? [];
  return (
    <div className="flex flex-col gap-1.5 border-line-soft border-t py-2.5" data-testid="trials">
      <div className="font-medium text-[13px]">The factory's changes</div>
      {list.length === 0 && (
        <div className="text-ink-3 text-xs">
          None yet. With self-improvement on, the factory looks once an hour.
        </div>
      )}
      {list.map((t) => (
        <div key={t.id} className="flex flex-wrap items-center gap-2 text-[13px]">
          <Chip tone={t.status === "promoted" ? "green" : "neutral"}>{t.status}</Chip>
          <span className="font-medium">{t.summary}</span>
          <span className="text-ink-3 text-xs">
            {t.status === "running"
              ? `${t.itemsSoFar} of ${t.targetItems} items`
              : (t.reason ?? "")}
          </span>
          <span className="grow" />
          {t.status === "running" && (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() =>
                void act(
                  editor,
                  () => op("config.trial.resolve", { projectId, trialId: t.id, stop: true }),
                  "Trial stopped.",
                )
              }
            >
              Stop
            </Button>
          )}
          {t.status === "promoted" &&
            t.baseVersion !== null &&
            t.candidateVersion === currentVersion && (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() =>
                  void act(
                    editor,
                    () =>
                      op(
                        "config.rollback",
                        {
                          projectId,
                          baseVersion: currentVersion,
                          toVersion: t.baseVersion as number,
                          note: `Reverted the factory's change: ${t.summary}`,
                        },
                        { idempotencyKey: submitKey() },
                      ),
                    "Reverted.",
                  )
                }
              >
                Revert
              </Button>
            )}
        </div>
      ))}
    </div>
  );
}

function AdjudicatorModes({
  projectId,
  modes,
  onChange,
}: {
  projectId: string;
  modes: Record<string, unknown>;
  onChange: (kind: "spec" | "step", mode: string) => void;
}) {
  const stats = useQuery(adjudicatorQuery(projectId));
  return (
    <div data-testid="adjudicator">
      {(
        [
          ["spec", "Spec gates"],
          ["step", "Gate steps"],
        ] as const
      ).map(([kind, label]) => {
        const s = stats.data?.[kind];
        const mode = typeof modes[kind] === "string" ? (modes[kind] as string) : "off";
        return (
          <EditField
            key={kind}
            label={label}
            help={
              s
                ? `${s.decisions} of its verdicts you also decided; ${s.approvals ? `${Math.round(s.precision * 100)}% of its approvals matched yours` : "no approvals yet"}. ${s.eligible ? "It has earned active mode." : "Not earned active mode yet (20 decisions, 95%)."}`
                : "Loading its record…"
            }
          >
            <Segmented
              label={label}
              options={
                s?.eligible || mode === "active" ? ["off", "shadow", "active"] : ["off", "shadow"]
              }
              value={mode}
              onChange={(v) => onChange(kind, v)}
            />
          </EditField>
        );
      })}
    </div>
  );
}

/** Every version, newest first; rolling back saves an earlier one as a new version. */
export function History({ editor }: { editor: ConfigEditor }) {
  const { config, currentVersion, busy } = editor;
  const [confirm, setConfirm] = useState<number | null>(null);
  const history = config.data?.history ?? [];
  return (
    <EditSection
      title="History"
      note="Newest first. Rolling back makes a new version."
      testId="history"
    >
      {history.length === 0 && <div className="py-2.5 text-ink-3 text-xs">No versions yet.</div>}
      {history.map((h) => (
        <div
          key={h.sha}
          className="flex flex-col gap-0.5 border-line-soft border-b py-2 text-[13px] last:border-b-0"
        >
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-xs">v{h.version}</span>
            {h.impact && h.impact !== "neutral" && <ImpactChip value={h.impact} />}
            <span className="text-ink-3 text-xs">{h.source}</span>
            <span className="grow" />
            <span className="text-ink-muted text-xs">
              {h.createdBy ? `${h.createdBy} · ` : ""}
              {ago(h.createdAt)}
            </span>
            {h.version !== null && h.version !== currentVersion && h.valid && (
              <Button
                size="sm"
                variant="outline"
                className="h-7"
                disabled={busy}
                onClick={() => setConfirm(h.version)}
              >
                Roll back
              </Button>
            )}
            {h.version === currentVersion && <Chip>current</Chip>}
          </div>
          {h.note && <div className="text-ink-3 text-xs">{h.note}</div>}
        </div>
      ))}
      <RollbackDialog editor={editor} toVersion={confirm} onClose={() => setConfirm(null)} />
    </EditSection>
  );
}

/**
 * Confirms a rollback with what it would change, as the engine classifies it against the current
 * version, and the difference itself; Roll back waits until both are on screen.
 */
function RollbackDialog({
  editor,
  toVersion,
  onClose,
}: {
  editor: ConfigEditor;
  toVersion: number | null;
  onClose: () => void;
}) {
  const { projectId, currentVersion, config } = editor;
  const target = config.data?.history.find((h) => h.version === toVersion)?.policy ?? null;
  const impact = useQuery({
    queryKey: ["config", projectId, "preview", "rollback", toVersion],
    queryFn: () => read("config.preview", { projectId, policy: target ?? {} }),
    enabled: toVersion !== null && !!target,
  });
  const changes = impact.data?.impact?.changes ?? [];
  const ready = !!impact.data?.impact;
  return (
    <AlertDialog open={toVersion !== null} onOpenChange={(o) => !o && onClose()}>
      <AlertDialogContent data-testid="rollback-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>Make v{toVersion} current again?</AlertDialogTitle>
          <AlertDialogDescription>
            {!ready
              ? impact.isError
                ? "The engine couldn't classify this rollback, so it can't be confirmed here."
                : "Classifying the change…"
              : impact.data?.impact?.class === "loosens"
                ? `It saves v${toVersion} as v${currentVersion + 1}. It loosens the config, so it waits for an approver.`
                : `It saves v${toVersion} as v${currentVersion + 1}, at once.`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {ready && (
          <div className="flex max-h-64 flex-col gap-2 overflow-y-auto">
            <ImpactList changes={changes} />
            <ChangeDiff before={editor.current?.policy ?? null} after={target} changes={changes} />
          </div>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={!ready}
            onClick={() => {
              onClose();
              if (toVersion === null) return;
              void act(
                editor,
                () =>
                  op(
                    "config.rollback",
                    { projectId, baseVersion: currentVersion, toVersion },
                    { idempotencyKey: submitKey() },
                  ),
                `Rolled back: v${toVersion} is current again.`,
              );
            }}
          >
            Roll back
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** A setting a project on an org workflow overrides (spec 52, Q5): the stage type and the key. */
interface Overridable {
  type: string;
  key: string;
  /** What the org's value means when its workflow leaves it unset. */
  unset: string;
}
const RETRY: Overridable = { type: "build", key: "retryLimit", unset: "the stage's default" };
const CHECKS: Overridable = { type: "checks", key: "requiredChecks", unset: "none" };
const SECTIONS_SETTING: Overridable = { type: "checks", key: "sections", unset: "every section" };
const REQUIRED_FROM: Overridable = {
  type: "interview-planning",
  key: "requiredFrom",
  unset: "the stage's default",
};
const SIZES = ["small", "medium", "large"] as const;

type OrgWorkflow =
  | { on: false }
  | {
      on: true;
      name: string;
      /** The org's value of a setting, and the stage id overrides are keyed by. */
      at: (s: Overridable) => { stageId: string | null; value: unknown };
      loading: boolean;
      /** The org workflow couldn't be read: say so, never "no stage". */
      failed: boolean;
    };

/**
 * The org workflow a project's config runs on, if any (`workflow` names an org workflow id): what
 * its stages set, so an override is shown against the org's value (PR #121's rules).
 */
function useOrgWorkflow(orgId: string | null, doc: Doc | null): OrgWorkflow {
  const id = orgWorkflowOf(doc);
  const wf = useQuery({ ...orgWorkflowQuery(orgId ?? "", id ?? ""), enabled: !!orgId && !!id });
  if (!id) return { on: false };
  const stages = (Array.isArray(wf.data?.workflow.stages) ? wf.data.workflow.stages : []) as {
    id: string;
    type: string;
    settings?: Doc;
  }[];
  return {
    on: true,
    name: typeof wf.data?.workflow.name === "string" ? wf.data.workflow.name : id,
    loading: wf.isPending && !wf.isError,
    failed: wf.isError,
    at: (s) => {
      const stage = stages.find((x) => x.type === s.type);
      return { stageId: stage?.id ?? null, value: obj(stage?.settings)[s.key] };
    },
  };
}

/**
 * A setting the org's workflow sets and a project may override: the org's value, whether this
 * project overrides it, Use the org's value, and that a looser override applies only once an org
 * admin approves it (the save's impact says whether it loosens).
 */
function OverrideField({
  org,
  setting,
  label,
  help,
  editor,
  block = false,
  render,
}: {
  org: Extract<OrgWorkflow, { on: true }>;
  setting: Overridable;
  label: string;
  help: string;
  editor: ConfigEditor;
  block?: boolean;
  render: (value: unknown, put: (v: unknown) => void) => ReactNode;
}) {
  const { stageId, value: orgValue } = org.at(setting);
  const overrides = obj(editor.doc?.workflowOverrides);
  const mine = stageId ? obj(overrides[stageId]) : {};
  const overridden = Object.hasOwn(mine, setting.key);
  // The saved override, as the engine sees it: looser than the org's, approved or not.
  const stored = editor.config.data?.orgOverrides.find(
    (o) => o.stageId === stageId && o.key === setting.key,
  );
  const { run, pending } = usePolicyDecide();
  const canDecide = useCanDecide();
  const put = (v: unknown) =>
    editor.set((d) => {
      if (!stageId) return;
      const all = { ...obj(d.workflowOverrides) };
      const stage = { ...obj(all[stageId]) };
      if (v === undefined) delete stage[setting.key];
      else stage[setting.key] = v;
      if (Object.keys(stage).length) all[stageId] = stage;
      else delete all[stageId];
      d.workflowOverrides = all;
    });
  const note = (
    <div className="flex flex-col items-start gap-1.5" data-testid={`override-${setting.key}`}>
      <span className="text-ink-3 text-xs">
        {org.name} sets {orgValue === undefined ? setting.unset : shown(orgValue)}.{" "}
        {overridden ? (
          <>
            <Chip tone="blue">Overridden here</Chip> A looser value than the org's applies only once
            an org admin approves it.
          </>
        ) : (
          "This project uses the org's value."
        )}
      </span>
      {overridden && (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" className="h-7" onClick={() => put(undefined)}>
            Use the org's value
          </Button>
          {stored?.looser &&
            (stored.approved ? (
              <Chip tone="green">An org admin approved this value</Chip>
            ) : (
              same(stored.value, mine[setting.key]) && (
                <Button
                  size="sm"
                  className="h-7"
                  disabled={pending !== null || !canDecide}
                  data-testid={`approve-override-${setting.key}`}
                  onClick={() =>
                    void run(
                      "override.approve",
                      {
                        projectId: editor.projectId,
                        stageId,
                        setting: setting.key,
                        orgVersion: stored.orgVersion,
                        value: stored.value,
                        configVersion: editor.currentVersion,
                      },
                      "Approved",
                    )
                  }
                >
                  Approve this value (org admin)
                </Button>
              )
            ))}
        </div>
      )}
    </div>
  );
  if (!stageId)
    return (
      <EditField label={label} help={org.loading ? "Loading the org's workflow…" : help}>
        <span className="text-ink-3 text-xs" data-testid={`override-${setting.key}`}>
          {org.failed
            ? "Couldn't read the org's workflow, so this can't be changed here now. Try again later."
            : org.loading
              ? ""
              : `${org.name} has no stage that sets this.`}
        </span>
      </EditField>
    );
  const control = render(overridden ? mine[setting.key] : orgValue, put);
  return block ? (
    <div className="flex flex-col gap-1.5 py-2.5">
      {note}
      {control}
    </div>
  ) : (
    <EditField label={label} help={help} below={note}>
      {control}
    </EditField>
  );
}

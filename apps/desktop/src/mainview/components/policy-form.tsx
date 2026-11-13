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
import { useState } from "react";
import { toast } from "sonner";
import { adjudicatorQuery, trialsQuery } from "../lib/factory-queries.ts";
import { OpError, op, submitKey } from "../lib/op.ts";
import {
  type ConfigEditor,
  changedPaths,
  type Doc,
  EditField,
  EditSection,
  ImpactChip,
  ListEditor,
  NumberInput,
  num,
  obj,
  Segmented,
  strs,
} from "./config-editor.tsx";
import { Chip } from "./shell-list.tsx";

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

export function PolicyForm({ editor }: { editor: ConfigEditor }) {
  const { doc, current, set } = editor;
  const [json, setJson] = useState<string | null>(null);
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
        title="Throughput"
        changed={changed.has("wipLimit") || changed.has("retryLimit")}
      >
        <EditField
          label="Waiting on you"
          help="How many items may wait at your gates before new builds stop."
        >
          <NumberInput
            label="Waiting on you"
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
        <EditField
          label="Build attempts per item"
          help="Automatic retries of a failed build or verify (0–5)."
        >
          <NumberInput
            label="Build attempts per item"
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
      </EditSection>

      <EditSection
        title="Review packet"
        note="Which sections show at the merge gate, and in what order."
        changed={changed.has("reviewPacket")}
      >
        <PacketEditor
          sections={sections}
          onChange={(next) =>
            set((d) => {
              d.reviewPacket = { sections: next };
            })
          }
        />
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
  const { config, currentVersion, busy, projectId } = editor;
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
                Roll back to this
              </Button>
            )}
            {h.version === currentVersion && <Chip>current</Chip>}
          </div>
          {h.note && <div className="text-ink-3 text-xs">{h.note}</div>}
        </div>
      ))}
      <AlertDialog open={confirm !== null} onOpenChange={(o) => !o && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Make v{confirm} current again?</AlertDialogTitle>
            <AlertDialogDescription>
              This saves it as a new version. If it loosens the config, it waits for an approver.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const toVersion = confirm;
                setConfirm(null);
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
    </EditSection>
  );
}

// A project's factory config (ADR 0370, spec 09 M1): a form over the current config version.
// Edits are batched; the save bar shows the server's impact summary (config.preview) before Save.
// A save that loosens the config waits for an approver; History rolls back to any version.
import { Badge } from "@software-factory/ui/components/badge";
import { Button } from "@software-factory/ui/components/button";
import { Card } from "@software-factory/ui/components/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@software-factory/ui/components/collapsible";
import { Input } from "@software-factory/ui/components/input";
import { Label } from "@software-factory/ui/components/label";
import { RadioGroup, RadioGroupItem } from "@software-factory/ui/components/radio-group";
import { Table, TableBody, TableCell, TableRow } from "@software-factory/ui/components/table";
import { Textarea } from "@software-factory/ui/components/textarea";
import { cn } from "@software-factory/ui/lib/utils";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ChevronDownIcon, ChevronRightIcon, ChevronUpIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import {
  changedPaths as changedOf,
  type Doc,
  Field,
  ImpactBadge,
  ListEditor,
  NumberInput,
  num,
  obj,
  Page,
  PendingChanges,
  SaveBar,
  Section,
  Segmented,
  strs,
  useConfigDraft,
} from "#/components/config-editor";
import { OptionSelect } from "#/components/option-select";
import { ago } from "#/lib/format";
import { op, submitKey } from "#/lib/op";
import { OpError } from "#/lib/ops";
import { adjudicatorQuery, configQuery, trialsQuery } from "#/lib/queries";
import { useProjects } from "#/lib/session";

export const Route = createFileRoute("/_app/projects/$projectId/settings")({
  loader: ({ context: { queryClient }, params }) =>
    Promise.all([
      queryClient.ensureQueryData(configQuery(params.projectId)),
      queryClient.ensureQueryData(trialsQuery(params.projectId)),
      queryClient.ensureQueryData(adjudicatorQuery(params.projectId)),
    ]).catch(() => null),
  component: SettingsPage,
});

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
const ALL_SECTIONS = SECTIONS.map((s) => s[0]);

function SettingsPage() {
  const { projectId } = Route.useParams();
  const projects = useProjects();
  const project = projects.data?.find((p) => p.id === projectId);
  const editor = useConfigDraft(projectId);
  const { config, current, currentVersion, setDraft, doc, set, busy, setBusy, refresh } = editor;
  const [json, setJson] = useState<string | null>(null);

  async function rollback(toVersion: number) {
    if (!window.confirm(`Make v${toVersion} current again? This saves it as a new version.`))
      return;
    setBusy(true);
    try {
      const r = await op(
        "config.rollback",
        { projectId, baseVersion: currentVersion, toVersion },
        { idempotencyKey: submitKey() },
      );
      toast.success(`Rolled back: v${toVersion} is current again, as v${r.version}.`);
      await refresh();
    } catch (error) {
      if (error instanceof OpError && error.code === "pending") {
        toast.success("Rolling back loosens the config, so it waits for an approver.");
      } else toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function exportBundle() {
    try {
      const out = await op("config.export", { projectId });
      const blob = new Blob([JSON.stringify(out.files, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${project?.slug ?? "project"}-factory-v${out.version ?? 0}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }

  async function importBundle(file: File) {
    try {
      const parsed = JSON.parse(await file.text()) as Doc;
      // Either an exported bundle ({ ".factory/policy.json": "…" }) or a bare policy.json.
      const inner = parsed[".factory/policy.json"];
      const policy = typeof inner === "string" ? (JSON.parse(inner) as Doc) : parsed;
      setDraft(policy);
      editor.setSource("import");
      editor.setNote(`Imported from ${file.name}`);
      toast.message(
        JSON.stringify(policy) === JSON.stringify(current?.policy)
          ? "That's the same as the current version: nothing to save."
          : "Imported into the form. Check the changes below, then save.",
      );
    } catch {
      toast.error("That file isn't a factory config export or a policy.json.");
    }
  }

  if (config.isError) {
    return (
      <Page title="Settings">
        <Card className="px-5 py-4 text-sm">
          Couldn't load this project's config: {config.error.message}
        </Card>
      </Page>
    );
  }
  if (!doc) {
    return (
      <Page title="Settings">
        <Card className="px-5 py-4 text-sm">
          {config.isPending ? "Loading…" : "This project has no config yet."}
        </Card>
      </Page>
    );
  }

  const overrides = obj(doc.overrides) as Overrides;
  const sections = Array.isArray(obj(doc.reviewPacket).sections)
    ? strs(obj(doc.reviewPacket).sections)
    : ALL_SECTIONS.slice();
  const changedPaths = changedOf(editor);

  return (
    <Page
      title="Settings"
      subtitle={
        <>
          {project?.name ?? "Project"} · config <span className="font-mono">v{currentVersion}</span>
          {current?.createdBy ? (
            // The relative time can tick between the server render and the client's.
            <span suppressHydrationWarning>
              {` · saved ${ago(current.createdAt)} by ${current.createdBy}`}
            </span>
          ) : (
            ""
          )}
        </>
      }
      actions={
        <>
          <Button size="sm" variant="outline" asChild>
            <Link to="/projects/$projectId/workflows" params={{ projectId }}>
              Workflows and agents
            </Link>
          </Button>
          <Button size="sm" variant="outline" onClick={() => setJson(JSON.stringify(doc, null, 2))}>
            Edit as JSON
          </Button>
          <Button size="sm" variant="ghost" onClick={exportBundle} data-testid="config-export">
            Export
          </Button>
          <Button size="sm" variant="ghost" asChild>
            <label className="cursor-pointer">
              <input
                type="file"
                accept="application/json,.json"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void importBundle(f);
                  e.target.value = "";
                }}
              />
              Import
            </label>
          </Button>
        </>
      }
    >
      <PendingChanges editor={editor} />
      <Card className="px-5 py-3 text-muted-foreground text-sm">
        Saving makes a new version. New work uses it straight away; running work keeps the stricter
        of its own version and the new one. A change that loosens the config waits for an approver.
      </Card>

      {json !== null && (
        <Section
          title="Edit as JSON"
          description="The whole document. Apply puts it in the form; nothing is saved yet."
        >
          <Textarea
            className="min-h-72 font-mono text-xs"
            value={json}
            onChange={(e) => setJson(e.target.value)}
            data-testid="config-json"
          />
          <div className="flex gap-2 pt-2">
            <Button
              size="sm"
              onClick={() => {
                try {
                  setDraft(JSON.parse(json) as Doc);
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
        </Section>
      )}

      <Section
        title="Autonomy"
        changed={changedPaths.has("autonomyPolicy") || changedPaths.has("gate")}
        description="How much agents may do without asking. Merge, deploy and self-modify always go to a person."
      >
        <RadioGroup
          className="gap-2 md:grid-cols-3"
          aria-label="Autonomy policy"
          data-testid="autonomy-picker"
          value={typeof doc.autonomyPolicy === "string" ? doc.autonomyPolicy : ""}
          onValueChange={(v) =>
            set((d) => {
              d.autonomyPolicy = v;
            })
          }
        >
          {AUTONOMY.map((a) => (
            <Label
              key={a.key}
              className={cn(
                "flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2.5 font-normal",
                doc.autonomyPolicy === a.key && "border-primary ring-1 ring-primary",
              )}
            >
              <RadioGroupItem value={a.key} className="mt-0.5" />
              <span className="grid gap-0.5">
                <span className="font-semibold">
                  {a.title}
                  {current?.policy?.autonomyPolicy === a.key && (
                    <span className="ml-2 font-normal text-muted-foreground text-xs">current</span>
                  )}
                </span>
                <span className="text-muted-foreground text-xs">{a.text}</span>
              </span>
            </Label>
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
      </Section>

      <Section
        title="Timeouts and people"
        changed={
          changedPaths.has("timeouts") ||
          changedPaths.has("approvers") ||
          changedPaths.has("backupOwner")
        }
      >
        <Field
          label="Gate timeout"
          help="Hours a gate waits before it goes to the backup owner. Never auto-accepted."
        >
          <NumberInput
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
        </Field>
        <Field
          label="Question timeout"
          help="Hours an agent's question waits before it goes to the backup owner."
        >
          <NumberInput
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
        </Field>
        <Field
          label="Approvers"
          help="GitHub logins who decide gates. Empty means the org's owners and admins."
        >
          <ListEditor
            items={strs(doc.approvers)}
            placeholder="github login"
            onChange={(next) =>
              set((d) => {
                d.approvers = next;
              })
            }
            testId="approvers"
          />
        </Field>
        <Field
          label="Backup owner"
          help="Gets a gate or question that timed out. Empty means the first approver."
        >
          <Input
            className="w-56"
            value={typeof doc.backupOwner === "string" ? doc.backupOwner : ""}
            placeholder="github login"
            onChange={(e) =>
              set((d) => {
                if (e.target.value.trim()) d.backupOwner = e.target.value.trim();
                else delete d.backupOwner;
              })
            }
          />
        </Field>
      </Section>

      <Section
        title="Throughput"
        changed={changedPaths.has("wipLimit") || changedPaths.has("retryLimit")}
      >
        <Field
          label="WIP limit"
          help="How many items may wait at your gates before new builds stop."
        >
          <NumberInput
            value={num(doc.wipLimit, 5)}
            min={1}
            max={100}
            suffix="items"
            onChange={(v) =>
              set((d) => {
                d.wipLimit = v;
              })
            }
            testId="wip-limit"
          />
        </Field>
        <Field
          label="Default retry limit"
          help="Automatic retries of a failed build or verify (0–5)."
        >
          <NumberInput
            value={num(doc.retryLimit, 2)}
            min={0}
            max={5}
            onChange={(v) =>
              set((d) => {
                d.retryLimit = v;
              })
            }
          />
        </Field>
      </Section>

      <Section
        title="Review packet"
        changed={changedPaths.has("reviewPacket")}
        description="Which of the packet's sections show at the merge gate, and in what order. The factory fills each one."
      >
        <PacketEditor
          sections={sections}
          onChange={(next) =>
            set((d) => {
              d.reviewPacket = { sections: next };
            })
          }
        />
      </Section>

      <Section title="Protection on the default branch" changed={changedPaths.has("protection")}>
        <Field
          label="When protection is red"
          help="Block keeps builds queued until the branch's rulesets are fixed."
        >
          <Segmented
            options={["warn", "block"]}
            value={(obj(doc.protection).onRed as string) ?? "warn"}
            onChange={(v) =>
              set((d) => {
                d.protection = { ...obj(d.protection), onRed: v };
              })
            }
          />
        </Field>
        <Field
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
        </Field>
      </Section>

      <Section
        title="Self-improvement"
        changed={changedPaths.has("improve")}
        description="The factory trials practice changes on its own (the builder's instructions and model tier), on the next few items, and keeps them only if those items do at least as well. Policy never changes this way."
      >
        <Field
          label="Let the factory improve its practice"
          help="Turning it on is a policy change: it waits for an approver."
        >
          <Segmented
            options={["off", "on"]}
            value={obj(doc.improve).enabled === true ? "on" : "off"}
            onChange={(v) =>
              set((d) => {
                d.improve = { ...obj(d.improve), enabled: v === "on" };
              })
            }
          />
        </Field>
        <Field
          label="Trial size"
          help="How many items a change is tried on before it's judged (3–20)."
        >
          <NumberInput
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
        </Field>
        <Field label="Weekly cap" help="At most this many changes a week (1–10).">
          <NumberInput
            value={num(obj(doc.improve).weeklyCap, 3)}
            min={1}
            max={10}
            onChange={(v) =>
              set((d) => {
                d.improve = { ...obj(d.improve), weeklyCap: v };
              })
            }
          />
        </Field>
        <Trials projectId={projectId} currentVersion={currentVersion} onChanged={refresh} />
      </Section>

      <Section
        title="Adjudicator"
        changed={changedPaths.has("adjudicator")}
        description="An agent that says how it would decide your spec gates and gate steps. In shadow mode it only records. It can go active for a kind once 20 of its verdicts match yours at least 95% of the time: then it approves (never rejects), and still leaves every fifth to you. Never merge, deploy or self-modify."
      >
        <AdjudicatorModes
          projectId={projectId}
          modes={obj(doc.adjudicator)}
          onChange={(kind, mode) =>
            set((d) => {
              d.adjudicator = { ...obj(d.adjudicator), [kind]: mode };
            })
          }
        />
      </Section>

      <SaveBar editor={editor} />

      <Section
        title="History"
        description="Every version, newest first. Rolling back makes a new version."
      >
        <ul className="grid gap-1.5 text-sm" data-testid="history">
          {(config.data?.history ?? []).map((h) => (
            <li key={h.sha} className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-xs">v{h.version}</span>
              {h.impact && h.impact !== "neutral" && <ImpactBadge value={h.impact} />}
              <span className="text-muted-foreground">{h.source}</span>
              <span className="min-w-0 truncate">{h.note ?? ""}</span>
              <span className="text-muted-foreground text-xs" suppressHydrationWarning>
                {h.createdBy ? `${h.createdBy} · ` : ""}
                {ago(h.createdAt)}
              </span>
              <span className="grow" />
              {h.version !== null && h.version !== currentVersion && h.valid && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => rollback(h.version as number)}
                >
                  Roll back to this
                </Button>
              )}
              {h.version === currentVersion && <Badge variant="secondary">current</Badge>}
            </li>
          ))}
        </ul>
      </Section>
    </Page>
  );
}

function OverridesEditor({
  overrides,
  onChange,
}: {
  overrides: Overrides;
  onChange: (next: Overrides) => void;
}) {
  const rows = useMemo(
    () =>
      Object.entries(overrides).flatMap(([actor, risks]) =>
        Object.entries(risks ?? {}).map(([risk, decision]) => ({ actor, risk, decision })),
      ),
    [overrides],
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
    <Collapsible className="group/collapsible pt-2 text-sm" defaultOpen={rows.length > 0}>
      <CollapsibleTrigger className="flex items-center gap-1 text-left cursor-pointer font-medium">
        <ChevronRightIcon className="size-3.5 shrink-0 transition-transform group-data-[state=open]/collapsible:rotate-90" />
        Overrides ({rows.length}){" "}
        <span className="font-normal text-muted-foreground">
          · per actor and risk class, on top of the autonomy policy
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <Table className="mt-2 w-full text-xs">
          <TableBody>
            {rows.map((r) => (
              <TableRow key={`${r.actor}.${r.risk}`} className="border-b last:border-b-0">
                <TableCell className="py-1.5">{r.actor}</TableCell>
                <TableCell className="font-mono">{r.risk}</TableCell>
                <TableCell>
                  <Segmented
                    options={["allow", "review", "deny"]}
                    value={r.decision}
                    onChange={(d) => put(r.actor, r.risk, d)}
                  />
                </TableCell>
                <TableCell className="text-right">
                  <Button size="sm" variant="ghost" onClick={() => put(r.actor, r.risk, null)}>
                    Remove
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <div className="flex flex-wrap items-center gap-2 pt-2">
          <OptionSelect aria-label="Actor" value={actor} options={ACTORS} onChange={setActor} />
          <OptionSelect
            aria-label="Risk class"
            value={risk}
            options={RISKS.map((r) =>
              LOCKED_RISKS.has(r)
                ? { value: r, label: `${r} (always a person)`, disabled: true }
                : r,
            )}
            onChange={setRisk}
          />
          <OptionSelect
            aria-label="Decision"
            value={decision}
            options={["allow", "review", "deny"]}
            onChange={setDecision}
          />
          <Button size="sm" variant="outline" onClick={() => put(actor, risk, decision)}>
            Add override
          </Button>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function PacketEditor({
  sections,
  onChange,
}: {
  sections: string[];
  onChange: (next: string[]) => void;
}) {
  // Shown sections in their order, then the hidden ones.
  const shown = sections.filter((s) => (ALL_SECTIONS as readonly string[]).includes(s));
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
    <ul className="grid" data-testid="packet-sections">
      {order.map((key) => {
        const meta = SECTIONS.find((s) => s[0] === key);
        const on = shown.includes(key);
        return (
          <li key={key} className="flex items-center gap-2 border-b py-2 last:border-b-0">
            <div className="flex flex-col">
              <Button
                size="icon"
                variant="ghost"
                className="size-5"
                aria-label="Up"
                disabled={!on}
                onClick={() => move(key, -1)}
              >
                <ChevronUpIcon />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                className="size-5"
                aria-label="Down"
                disabled={!on}
                onClick={() => move(key, 1)}
              >
                <ChevronDownIcon />
              </Button>
            </div>
            <div className={cn("grow", !on && "opacity-50")}>
              <div className="font-medium text-sm">
                {meta?.[1]} <span className="font-mono text-muted-foreground text-xs">{key}</span>
              </div>
              <div className="text-muted-foreground text-xs">{meta?.[2]}</div>
            </div>
            <Segmented
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
function Trials({
  projectId,
  currentVersion,
  onChanged,
}: {
  projectId: string;
  currentVersion: number;
  onChanged: () => Promise<void>;
}) {
  const trials = useQuery(trialsQuery(projectId));
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const list = trials.data?.trials ?? [];
  async function act(fn: () => Promise<unknown>, done: string) {
    setBusy(true);
    try {
      await fn();
      toast.success(done);
      await queryClient.invalidateQueries({ queryKey: ["config", projectId] });
      await onChanged();
    } catch (error) {
      if (error instanceof OpError && error.code === "pending") {
        toast.success("Reverting loosens the config, so it waits for an approver.");
      } else toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="grid gap-1.5 pt-2" data-testid="trials">
      <div className="font-medium text-sm">The factory's changes</div>
      {list.length === 0 && (
        <p className="text-muted-foreground text-sm">
          None yet. With self-improvement on, the factory looks once an hour.
        </p>
      )}
      <ul className="grid gap-1.5 text-sm">
        {list.map((t) => (
          <li
            key={t.id}
            className="flex flex-wrap items-center gap-2 border-b pb-1.5 last:border-b-0"
          >
            <Badge variant={t.status === "promoted" ? "default" : "outline"}>{t.status}</Badge>
            <span className="font-medium">{t.summary}</span>
            <span className="text-muted-foreground text-xs">
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
                  act(
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
                    act(
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
          </li>
        ))}
      </ul>
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
    <div className="grid" data-testid="adjudicator">
      {(
        [
          ["spec", "Spec gates"],
          ["step", "Gate steps"],
        ] as const
      ).map(([kind, label]) => {
        const s = stats.data?.[kind];
        const mode = typeof modes[kind] === "string" ? (modes[kind] as string) : "off";
        return (
          <Field
            key={kind}
            label={label}
            help={
              s
                ? `${s.decisions} of its verdicts you also decided; ${s.approvals ? `${Math.round(s.precision * 100)}% of its approvals matched yours` : "no approvals yet"}. ${s.eligible ? "It has earned active mode." : "Not earned active mode yet (20 decisions, 95%)."}`
                : "Loading its record…"
            }
          >
            <Segmented
              options={
                s?.eligible || mode === "active" ? ["off", "shadow", "active"] : ["off", "shadow"]
              }
              value={mode}
              onChange={(v) => onChange(kind, v)}
            />
          </Field>
        );
      })}
    </div>
  );
}

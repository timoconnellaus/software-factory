// A project's factory config (ADR 0370, spec 09 M1): a form over the current config version.
// Edits are batched; the save bar shows the server's impact summary (config.preview) before Save.
// A save that loosens the config waits for an approver; History rolls back to any version.
import { Badge } from "@software-factory/ui/components/badge";
import { Button } from "@software-factory/ui/components/button";
import { Card } from "@software-factory/ui/components/card";
import { Input } from "@software-factory/ui/components/input";
import { Label } from "@software-factory/ui/components/label";
import { Textarea } from "@software-factory/ui/components/textarea";
import { cn } from "@software-factory/ui/lib/utils";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { ago } from "#/lib/format";
import { op, read, submitKey } from "#/lib/op";
import { OpError } from "#/lib/ops";
import { configQuery } from "#/lib/queries";
import { useProjects } from "#/lib/session";

export const Route = createFileRoute("/_app/projects/$projectId/settings")({
  loader: ({ context: { queryClient }, params }) =>
    queryClient.ensureQueryData(configQuery(params.projectId)).catch(() => null),
  component: SettingsPage,
});

type Doc = Record<string, unknown>;
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

const num = (v: unknown, d: number) => (typeof v === "number" ? v : d);
const obj = (v: unknown): Doc =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Doc) : {};
const strs = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];

function SettingsPage() {
  const { projectId } = Route.useParams();
  const projects = useProjects();
  const project = projects.data?.find((p) => p.id === projectId);
  const config = useQuery(configQuery(projectId));
  const queryClient = useQueryClient();
  const current = config.data?.current ?? null;
  const [draft, setDraft] = useState<Doc | null>(null);
  const [note, setNote] = useState("");
  const [source, setSource] = useState<"app" | "import">("app");
  const [busy, setBusy] = useState(false);
  const [json, setJson] = useState<string | null>(null);

  // Start (or restart) from the current version when it changes underneath us.
  const currentVersion = current?.version ?? 0;
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only when the version moves.
  useEffect(() => {
    setDraft(current?.policy ? structuredClone(current.policy) : null);
    setNote("");
    setSource("app");
  }, [currentVersion]);

  const doc = draft ?? current?.policy ?? null;
  const dirty =
    !!draft && !!current?.policy && JSON.stringify(draft) !== JSON.stringify(current.policy);
  const preview = useQuery({
    queryKey: ["config", projectId, "preview", draft],
    queryFn: () => read("config.preview", { projectId, policy: draft ?? {} }),
    enabled: dirty,
    placeholderData: keepPreviousData,
  });

  const set = (patch: (d: Doc) => void) =>
    setDraft((prev) => {
      const next = structuredClone(prev ?? current?.policy ?? {});
      patch(next);
      return next;
    });

  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: ["config", projectId] });
    await queryClient.invalidateQueries({ queryKey: ["projects"] });
  }

  async function save() {
    if (!draft) return;
    setBusy(true);
    try {
      const r = await op(
        "config.save",
        { projectId, baseVersion: currentVersion, policy: draft, note: note || undefined, source },
        { idempotencyKey: submitKey() },
      );
      toast.success(`Saved as v${r.version}.`);
      await refresh();
    } catch (error) {
      if (error instanceof OpError && error.code === "pending") {
        toast.success(
          "This loosens the config, so it waits for an approver. It's in their inbox.",
          {
            duration: 10_000,
          },
        );
        setDraft(null);
        await refresh();
      } else {
        toast.error(error instanceof Error ? error.message : String(error), { duration: 15_000 });
      }
    } finally {
      setBusy(false);
    }
  }

  async function rollback(toVersion: number) {
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
      setSource("import");
      setNote(`Imported from ${file.name}`);
      toast.message("Imported into the form. Check the changes below, then save.");
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
  const changedPaths = new Set(
    (preview.data?.impact?.changes ?? []).map((c) => c.path.split(".")[0]),
  );

  return (
    <Page
      title="Settings"
      subtitle={
        <>
          {project?.name ?? "Project"} · config <span className="font-mono">v{currentVersion}</span>
          {current?.createdBy ? ` · saved ${ago(current.createdAt)} by ${current.createdBy}` : ""}
        </>
      }
      actions={
        <>
          <Button size="sm" variant="outline" onClick={() => setJson(JSON.stringify(doc, null, 2))}>
            Edit as JSON
          </Button>
          <Button size="sm" variant="ghost" onClick={exportBundle} data-testid="config-export">
            Export
          </Button>
          <label className="inline-flex">
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
            <span className="inline-flex h-8 cursor-pointer items-center rounded-md px-3 text-sm hover:bg-accent">
              Import
            </span>
          </label>
        </>
      }
    >
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
        <div className="grid gap-2 md:grid-cols-3" data-testid="autonomy-picker">
          {AUTONOMY.map((a) => (
            <button
              key={a.key}
              type="button"
              onClick={() =>
                set((d) => {
                  d.autonomyPolicy = a.key;
                })
              }
              className={cn(
                "rounded-lg border px-3 py-2.5 text-left text-sm",
                doc.autonomyPolicy === a.key && "border-primary ring-1 ring-primary",
              )}
            >
              <div className="font-semibold">
                {a.title}
                {current?.policy?.autonomyPolicy === a.key && (
                  <span className="ml-2 font-normal text-muted-foreground text-xs">current</span>
                )}
              </div>
              <div className="text-muted-foreground text-xs">{a.text}</div>
            </button>
          ))}
        </div>
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

      {dirty && (
        <Card className="sticky bottom-3 gap-3 px-5 py-4 shadow-lg" data-testid="save-bar">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold text-sm">Unsaved changes</span>
            {preview.data?.impact?.class === "loosens" && (
              <Badge variant="outline" className="border-amber-500">
                loosens: needs an approver
              </Badge>
            )}
            {preview.data && !preview.data.valid && (
              <Badge variant="destructive">not valid: {preview.data.error}</Badge>
            )}
            <span className="grow" />
            <Button size="sm" variant="ghost" onClick={() => setDraft(null)} disabled={busy}>
              Discard
            </Button>
            <Button
              size="sm"
              onClick={save}
              disabled={busy || !preview.data?.valid}
              data-testid="config-save"
            >
              {busy
                ? "Saving…"
                : preview.data?.impact?.class === "loosens"
                  ? "Send for approval"
                  : `Save v${currentVersion + 1}`}
            </Button>
          </div>
          <ul className="grid gap-1 text-sm" data-testid="impact">
            {(preview.data?.impact?.changes ?? []).map((c) => (
              <li key={`${c.path}-${c.summary}`} className="flex items-start gap-2">
                <ImpactBadge value={c.class} />
                <span>{c.summary}</span>
              </li>
            ))}
          </ul>
          <Input
            placeholder="Why (optional, shows in History)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </Card>
      )}

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
              <span className="text-muted-foreground text-xs">
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

function Page({
  title,
  subtitle,
  actions,
  children,
}: {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <main className="mx-auto grid w-full grid-cols-[minmax(0,1fr)] max-w-[920px] gap-4 p-4 md:p-6">
      <div className="flex flex-wrap items-start gap-2">
        <div className="grow">
          <h1 className="font-semibold text-2xl tracking-tight">{title}</h1>
          {subtitle && <div className="text-muted-foreground text-sm">{subtitle}</div>}
        </div>
        {actions}
        <Button size="sm" variant="ghost" asChild>
          <Link to="/setup">Setup</Link>
        </Button>
      </div>
      {children}
    </main>
  );
}

function Section({
  title,
  description,
  changed,
  children,
}: {
  title: string;
  description?: string;
  changed?: boolean;
  children: ReactNode;
}) {
  return (
    <Card className={cn("gap-2 px-5 py-4", changed && "border-amber-500/70")}>
      <div>
        <h2 className="font-semibold">{title}</h2>
        {description && <p className="text-muted-foreground text-sm">{description}</p>}
      </div>
      {children}
    </Card>
  );
}

function Field({ label, help, children }: { label: string; help: string; children: ReactNode }) {
  return (
    <div className="grid items-start gap-2 border-b py-3 last:border-b-0 md:grid-cols-[1fr_auto]">
      <div>
        <Label>{label}</Label>
        <p className="text-muted-foreground text-xs">{help}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2 md:justify-end">{children}</div>
    </div>
  );
}

function NumberInput({
  value,
  min,
  max,
  suffix,
  onChange,
  testId,
}: {
  value: number;
  min: number;
  max: number;
  suffix?: string;
  onChange: (v: number) => void;
  testId?: string;
}) {
  return (
    <>
      <Input
        type="number"
        className="w-24"
        value={value}
        min={min}
        max={max}
        data-testid={testId}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v)) onChange(v);
        }}
      />
      {suffix && <span className="text-muted-foreground text-sm">{suffix}</span>}
    </>
  );
}

function Segmented({
  options,
  value,
  onChange,
}: {
  options: string[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="inline-flex overflow-hidden rounded-md border">
      {options.map((o) => (
        <button
          key={o}
          type="button"
          onClick={() => onChange(o)}
          className={cn(
            "border-r px-3 py-1.5 text-sm capitalize last:border-r-0",
            value === o && "bg-primary text-primary-foreground",
          )}
        >
          {o}
        </button>
      ))}
    </div>
  );
}

function ListEditor({
  items,
  placeholder,
  onChange,
  testId,
}: {
  items: string[];
  placeholder: string;
  onChange: (next: string[]) => void;
  testId?: string;
}) {
  const [value, setValue] = useState("");
  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid={testId}>
      {items.map((item) => (
        <span
          key={item}
          className="inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs"
        >
          {item}
          <button
            type="button"
            aria-label={`Remove ${item}`}
            className="text-muted-foreground"
            onClick={() => onChange(items.filter((i) => i !== item))}
          >
            ✕
          </button>
        </span>
      ))}
      <form
        className="inline-flex gap-1"
        onSubmit={(e) => {
          e.preventDefault();
          const v = value.trim();
          if (v && !items.includes(v)) onChange([...items, v]);
          setValue("");
        }}
      >
        <Input
          className="h-7 w-36 text-xs"
          placeholder={placeholder}
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <Button size="sm" variant="ghost" type="submit" className="h-7">
          Add
        </Button>
      </form>
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
    <details className="pt-2 text-sm" open={rows.length > 0}>
      <summary className="cursor-pointer font-medium">
        Overrides ({rows.length}){" "}
        <span className="font-normal text-muted-foreground">
          · per actor and risk class, on top of the autonomy policy
        </span>
      </summary>
      <table className="mt-2 w-full text-xs">
        <tbody>
          {rows.map((r) => (
            <tr key={`${r.actor}.${r.risk}`} className="border-b last:border-b-0">
              <td className="py-1.5">{r.actor}</td>
              <td className="font-mono">{r.risk}</td>
              <td>
                <Segmented
                  options={["allow", "review", "deny"]}
                  value={r.decision}
                  onChange={(d) => put(r.actor, r.risk, d)}
                />
              </td>
              <td className="text-right">
                <Button size="sm" variant="ghost" onClick={() => put(r.actor, r.risk, null)}>
                  Remove
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="flex flex-wrap items-center gap-2 pt-2">
        <select
          className="h-8 rounded-md border bg-background px-2"
          value={actor}
          onChange={(e) => setActor(e.target.value)}
        >
          {ACTORS.map((a) => (
            <option key={a}>{a}</option>
          ))}
        </select>
        <select
          className="h-8 rounded-md border bg-background px-2"
          value={risk}
          onChange={(e) => setRisk(e.target.value)}
        >
          {RISKS.map((r) => (
            <option key={r} disabled={LOCKED_RISKS.has(r)}>
              {r}
              {LOCKED_RISKS.has(r) ? " (always a person)" : ""}
            </option>
          ))}
        </select>
        <select
          className="h-8 rounded-md border bg-background px-2"
          value={decision}
          onChange={(e) => setDecision(e.target.value)}
        >
          {["allow", "review", "deny"].map((d) => (
            <option key={d}>{d}</option>
          ))}
        </select>
        <Button size="sm" variant="outline" onClick={() => put(actor, risk, decision)}>
          Add override
        </Button>
      </div>
    </details>
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
              <button
                type="button"
                aria-label="Up"
                disabled={!on}
                onClick={() => move(key, -1)}
                className="text-xs disabled:opacity-30"
              >
                ▲
              </button>
              <button
                type="button"
                aria-label="Down"
                disabled={!on}
                onClick={() => move(key, 1)}
                className="text-xs disabled:opacity-30"
              >
                ▼
              </button>
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

function ImpactBadge({ value }: { value: string }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        value === "loosens" && "border-amber-500 text-amber-700 dark:text-amber-400",
        value === "tightens" && "border-emerald-500 text-emerald-700 dark:text-emerald-400",
      )}
    >
      {value}
    </Badge>
  );
}

// Editing a project's config (ADR 0370): the draft over the current version, the save bar with the
// server's impact summary (config.preview), and the small form pieces the Settings and Workflows
// pages share. Every page saves the whole document through config.save.
import { Badge } from "@software-factory/ui/components/badge";
import { Button } from "@software-factory/ui/components/button";
import { Card } from "@software-factory/ui/components/card";
import { Input } from "@software-factory/ui/components/input";
import { Label } from "@software-factory/ui/components/label";
import { cn } from "@software-factory/ui/lib/utils";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useEffect, useState } from "react";
import { toast } from "sonner";
import { op, read, submitKey } from "#/lib/op";
import { OpError } from "#/lib/ops";
import { configQuery } from "#/lib/queries";

export type Doc = Record<string, unknown>;

export const num = (v: unknown, d: number) => (typeof v === "number" ? v : d);
export const obj = (v: unknown): Doc =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Doc) : {};
export const strs = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];

/** A draft of the project's config over its current version, and how to save it. */
export function useConfigDraft(projectId: string) {
  const config = useQuery(configQuery(projectId));
  const queryClient = useQueryClient();
  const current = config.data?.current ?? null;
  const [draft, setDraft] = useState<Doc | null>(null);
  const [note, setNote] = useState("");
  const [source, setSource] = useState<"app" | "import">("app");
  const [busy, setBusy] = useState(false);

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

  return {
    projectId,
    config,
    current,
    currentVersion,
    draft,
    setDraft,
    doc,
    dirty,
    preview,
    set,
    note,
    setNote,
    source,
    setSource,
    busy,
    setBusy,
    refresh,
    save,
  };
}

export type ConfigEditor = ReturnType<typeof useConfigDraft>;

/** The changed paths' first segments, for highlighting the sections a draft touches. */
export function changedPaths(editor: ConfigEditor): Set<string> {
  return new Set(
    (editor.preview.data?.impact?.changes ?? []).map((c) => c.path.split(".")[0] ?? ""),
  );
}

/** Saves and rollbacks that loosen the config and wait for an approver. */
export function PendingChanges({ editor }: { editor: ConfigEditor }) {
  const pending = editor.config.data?.pending ?? [];
  if (pending.length === 0) return null;
  return (
    <Card className="gap-1 border-amber-500/70 px-5 py-3 text-sm" data-testid="config-pending">
      <div className="font-medium">
        {pending.length === 1 ? "A change is" : `${pending.length} changes are`} waiting for an
        approver
      </div>
      <ul className="grid gap-0.5 text-muted-foreground">
        {pending.map((p) => (
          <li key={p.pendingActionId}>
            {p.operation === "config.rollback" ? "Rollback" : "Save"}
            {p.note ? `: ${p.note}` : ""}
            {p.by ? ` · by ${p.by}` : ""}
            {p.baseVersion !== null && p.baseVersion !== editor.currentVersion
              ? ` · edited from v${p.baseVersion}, so it can't apply any more: propose it again`
              : ""}
          </li>
        ))}
      </ul>
      <Link to="/" className="text-xs underline">
        Open the inbox
      </Link>
    </Card>
  );
}

export function SaveBar({ editor }: { editor: ConfigEditor }) {
  const { dirty, preview, busy, setDraft, save, currentVersion, note, setNote } = editor;
  if (!dirty) return null;
  const loosens = preview.data?.impact?.class === "loosens";
  return (
    <Card className="sticky bottom-3 z-10 gap-3 px-5 py-4 shadow-lg" data-testid="save-bar">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold text-sm">Unsaved changes</span>
        {loosens && (
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
          {busy ? "Saving…" : loosens ? "Send for approval" : `Save v${currentVersion + 1}`}
        </Button>
      </div>
      <ul className="grid max-h-40 gap-1 overflow-y-auto text-sm" data-testid="impact">
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
  );
}

export function Page({
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
    <div className="mx-auto grid w-full grid-cols-[minmax(0,1fr)] max-w-[920px] gap-4 p-4 pb-64 md:p-6 md:pb-64">
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
    </div>
  );
}

export function Section({
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

export function Field({
  label,
  help,
  children,
}: {
  label: string;
  help: string;
  children: ReactNode;
}) {
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

export function NumberInput({
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

export function Segmented({
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

export function ListEditor({
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

export function ImpactBadge({ value }: { value: string }) {
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

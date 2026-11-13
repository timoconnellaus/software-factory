// Editing a project's config in the desktop app (ADR 0370, 0610; ported from sf-app's
// config-editor): a draft over the current version, the save bar with the engine's classified impact
// (`config.preview`) and the small form pieces the Policy page uses. Saving is `config.save` with the
// version the draft was made from: a change that tightens or is neutral applies at once, one that
// loosens comes back `pending` and waits for an approver, who decides it with Touch ID
// (`PendingChanges`). The impact is the engine's, never worked out here.
import { Button } from "@software-factory/ui/components/button";
import { Input } from "@software-factory/ui/components/input";
import { ToggleGroup, ToggleGroupItem } from "@software-factory/ui/components/toggle-group";
import { cn } from "@software-factory/ui/lib/utils";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { XIcon } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { toast } from "sonner";
import { configQuery } from "../lib/factory-queries.ts";
import { OpError, op, read, submitKey } from "../lib/op.ts";
import { Chip, Panel, SectionTitle } from "./shell-list.tsx";

export type Doc = Record<string, unknown>;

export const num = (v: unknown, d: number) => (typeof v === "number" ? v : d);
export const obj = (v: unknown): Doc =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Doc) : {};
export const strs = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/** A draft of the project's config over its current version, and how to save it. */
export function useConfigDraft(projectId: string) {
  const config = useQuery({ ...configQuery(projectId), enabled: !!projectId });
  const queryClient = useQueryClient();
  const current = config.data?.current ?? null;
  const [draft, setDraft] = useState<Doc | null>(null);
  const [note, setNote] = useState("");
  const [source, setSource] = useState<"app" | "import">("app");
  const [busy, setBusy] = useState(false);

  // Start again from the current version when it moves underneath the draft.
  const currentVersion = current?.version ?? 0;
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only when the version moves.
  useEffect(() => {
    setDraft(null);
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
    await queryClient.invalidateQueries({ queryKey: ["inbox"] });
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
        toast.success("This loosens the config, so it waits for an approver.", {
          duration: 10_000,
        });
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

/** The first segments of the paths a draft changes, to mark the sections it touches. */
export function changedPaths(editor: ConfigEditor): Set<string> {
  return new Set(
    (editor.preview.data?.impact?.changes ?? []).map((c) => c.path.split(".")[0] ?? ""),
  );
}

/** How a change moves the config, as the engine classified it. */
export function ImpactChip({ value }: { value: string }) {
  return (
    <Chip
      tone={value === "loosens" ? "amber" : value === "tightens" ? "green" : "neutral"}
      data-impact={value}
    >
      {value}
    </Chip>
  );
}

/** The changes a draft (or a waiting proposal) makes, each with its class. */
export function ImpactList({
  changes,
  testId,
}: {
  changes: { path: string; summary: string; class: string }[];
  testId?: string;
}) {
  return (
    <ul className="m-0 flex list-none flex-col gap-1 p-0 text-[13px]" data-testid={testId}>
      {changes.map((c) => (
        <li key={`${c.path}-${c.summary}`} className="flex items-start gap-2">
          <ImpactChip value={c.class} />
          <span className="min-w-0">{c.summary}</span>
        </li>
      ))}
    </ul>
  );
}

/** Unsaved changes: the engine's impact, a note for History, Discard and Save. */
export function SaveBar({ editor }: { editor: ConfigEditor }) {
  const { dirty, preview, busy, setDraft, save, currentVersion, note, setNote } = editor;
  if (!dirty) return null;
  const loosens = preview.data?.impact?.class === "loosens";
  const invalid = preview.data && !preview.data.valid;
  return (
    <Panel needsYou className="sticky bottom-3 z-10 gap-2.5 shadow-lg" data-testid="save-bar">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold text-[13px]">Unsaved changes</span>
        {loosens && <Chip tone="amber">Loosens: waits for an approver</Chip>}
        {invalid && <Chip tone="amber">Not valid: {preview.data?.error}</Chip>}
        <span className="grow" />
        <Button size="sm" variant="ghost" onClick={() => setDraft(null)} disabled={busy}>
          Discard
        </Button>
        <Button
          size="sm"
          onClick={() => void save()}
          disabled={busy || !preview.data?.valid}
          data-testid="config-save"
        >
          {busy ? "Saving…" : loosens ? "Send for approval" : `Save v${currentVersion + 1}`}
        </Button>
      </div>
      <div className="max-h-40 overflow-y-auto">
        <ImpactList changes={preview.data?.impact?.changes ?? []} testId="impact" />
      </div>
      <Input
        placeholder="Why (optional, shows in History)"
        value={note}
        aria-label="Why"
        onChange={(e) => setNote(e.target.value)}
      />
    </Panel>
  );
}

/** A titled group of fields; marked when the draft changes something in it. */
export function EditSection({
  title,
  note,
  changed = false,
  testId,
  children,
}: {
  title: string;
  note?: string;
  changed?: boolean;
  testId?: string;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2" data-testid={testId}>
      <SectionTitle note={note}>
        {title}
        {changed && <Chip tone="amber">Changed</Chip>}
      </SectionTitle>
      <Panel className="gap-0 py-0">{children}</Panel>
    </section>
  );
}

/** One setting: its label and help on the left, the control on the right. */
export function EditField({
  label,
  help,
  children,
}: {
  label: string;
  help?: string;
  children: ReactNode;
}) {
  return (
    <div className="grid items-center gap-x-4 gap-y-1.5 border-line-soft border-b py-2.5 last:border-b-0 min-[900px]:grid-cols-[minmax(0,1fr)_auto]">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="font-medium text-[13px]">{label}</span>
        {help && <span className="text-ink-3 text-xs">{help}</span>}
      </div>
      <div className="flex flex-wrap items-center gap-2 min-[900px]:justify-end">{children}</div>
    </div>
  );
}

export function NumberInput({
  value,
  min,
  max,
  suffix,
  label,
  onChange,
  testId,
}: {
  value: number;
  min: number;
  max: number;
  suffix?: string;
  label: string;
  onChange: (v: number) => void;
  testId?: string;
}) {
  return (
    <>
      <Input
        type="number"
        className="h-8 w-20"
        value={value}
        min={min}
        max={max}
        aria-label={label}
        data-testid={testId}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v)) onChange(v);
        }}
      />
      {suffix && <span className="text-ink-3 text-xs">{suffix}</span>}
    </>
  );
}

/** One of a few: a ToggleGroup that can't be cleared. */
export function Segmented({
  options,
  value,
  label,
  onChange,
}: {
  options: readonly string[];
  value: string;
  label: string;
  onChange: (v: string) => void;
}) {
  return (
    <ToggleGroup
      type="single"
      variant="outline"
      size="sm"
      aria-label={label}
      value={value}
      onValueChange={(v) => v && onChange(v)}
    >
      {options.map((o) => (
        <ToggleGroupItem
          key={o}
          value={o}
          className="px-3 capitalize data-[state=on]:bg-primary data-[state=on]:text-primary-foreground"
        >
          {o}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

/** A list of short strings (GitHub logins, check names): chips with remove, and an Add box. */
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
        <Chip key={item} className="gap-0.5 pr-0.5">
          {item}
          <Button
            size="icon"
            variant="ghost"
            aria-label={`Remove ${item}`}
            className="size-4 rounded-full text-ink-3"
            onClick={() => onChange(items.filter((i) => i !== item))}
          >
            <XIcon className="size-3" />
          </Button>
        </Chip>
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
          className={cn("h-7 w-36 text-xs")}
          placeholder={placeholder}
          aria-label={placeholder}
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <Button size="sm" variant="outline" type="submit" className="h-7">
          Add
        </Button>
      </form>
    </div>
  );
}

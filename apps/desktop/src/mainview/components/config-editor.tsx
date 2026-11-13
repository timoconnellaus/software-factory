// Editing a project's config in the desktop app (ADR 0370, 0610; ported from sf-app's
// config-editor): a draft over the current version, the save bar with the engine's classified impact
// (`config.preview`) and the small form pieces the Policy page uses. Saving is `config.save` with the
// version the draft was made from: a change that tightens or is neutral applies at once, one that
// loosens comes back `pending` and waits for an approver, who decides it with Touch ID
// (`PendingChanges`). The impact is the engine's, never worked out here.
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
import { ToggleGroup, ToggleGroupItem } from "@software-factory/ui/components/toggle-group";
import { cn } from "@software-factory/ui/lib/utils";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { useBlocker } from "@tanstack/react-router";
import { XIcon } from "lucide-react";
import { type ReactNode, useState } from "react";
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

/**
 * A draft is tied to the project and the version it was made from, so it can never be saved to
 * another project, nor over a version it wasn't made from without the person seeing the difference.
 */
export interface Draft {
  projectId: string;
  baseVersion: number;
  doc: Doc;
}

/**
 * What the form shows for a draft (pure; tested): another project's draft is ignored; a draft whose
 * version moved underneath it is kept and marked `moved`, to be reviewed against the new version.
 */
export function draftView(
  draft: Draft | null,
  projectId: string,
  current: { version: number | null; policy: Doc | null } | null,
): { draft: Draft | null; doc: Doc | null; dirty: boolean; moved: boolean } {
  const mine = draft && draft.projectId === projectId ? draft : null;
  const policy = current?.policy ?? null;
  const doc = mine?.doc ?? policy;
  const moved = !!mine && mine.baseVersion !== (current?.version ?? 0);
  const dirty =
    !!mine && !!policy && (moved || JSON.stringify(mine.doc) !== JSON.stringify(policy));
  return { draft: mine, doc, dirty, moved };
}

/** A draft of the project's config over its current version, and how to save it. */
export function useConfigDraft(projectId: string) {
  const config = useQuery({ ...configQuery(projectId), enabled: !!projectId });
  const queryClient = useQueryClient();
  const current = config.data?.current ?? null;
  const [raw, setRaw] = useState<Draft | null>(null);
  const [note, setNote] = useState("");
  const [source, setSource] = useState<"app" | "import">("app");
  const [busy, setBusy] = useState(false);
  const currentVersion = current?.version ?? 0;
  const { draft, doc, dirty, moved } = draftView(raw, projectId, current);

  const preview = useQuery({
    queryKey: ["config", projectId, "preview", draft?.doc ?? null],
    queryFn: () => read("config.preview", { projectId, policy: draft?.doc ?? {} }),
    enabled: dirty,
    placeholderData: keepPreviousData,
  });

  const setDraft = (next: Doc | null) =>
    setRaw(
      next ? { projectId, baseVersion: draft?.baseVersion ?? currentVersion, doc: next } : null,
    );
  const set = (patch: (d: Doc) => void) =>
    setRaw((prev) => {
      const mine = prev && prev.projectId === projectId ? prev : null;
      const next = structuredClone(mine?.doc ?? current?.policy ?? {});
      patch(next);
      return { projectId, baseVersion: mine?.baseVersion ?? currentVersion, doc: next };
    });
  /** Keep the draft's changes on the version that is current now, after reviewing the difference. */
  const rebase = () =>
    setRaw((prev) =>
      prev && prev.projectId === projectId ? { ...prev, baseVersion: currentVersion } : prev,
    );

  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: ["config", projectId] });
    await queryClient.invalidateQueries({ queryKey: ["inbox"] });
  }

  async function save() {
    if (!draft || moved) return;
    // The draft's own project and base: never the page's, which may have changed under it.
    const { projectId: target, baseVersion, doc: policy } = draft;
    setBusy(true);
    try {
      const r = await op(
        "config.save",
        { projectId: target, baseVersion, policy, note: note || undefined, source },
        { idempotencyKey: submitKey() },
      );
      toast.success(`Saved as v${r.version}.`);
      setRaw(null);
      setNote("");
      await refresh();
    } catch (error) {
      if (error instanceof OpError && error.code === "pending") {
        toast.success("This loosens the config, so it waits for an approver.", {
          duration: 10_000,
        });
        setRaw(null);
        setNote("");
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
    draft: draft?.doc ?? null,
    baseVersion: draft?.baseVersion ?? currentVersion,
    setDraft,
    doc,
    dirty,
    moved,
    rebase,
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

/** The value at a dotted path of a config document, or undefined. */
export function valueAt(doc: Doc | null, path: string): unknown {
  let v: unknown = doc;
  for (const key of path.split(".")) {
    if (!v || typeof v !== "object") return undefined;
    v = (v as Doc)[key];
  }
  return v;
}

/** A setting's value, short enough for one line. */
export function shown(v: unknown): string {
  if (v === undefined || v === null) return "not set";
  if (typeof v === "string") return v || "empty";
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v) && v.every((x) => typeof x !== "object"))
    return v.length ? v.join(", ") : "none";
  const json = JSON.stringify(v);
  return json.length > 120 ? `${json.slice(0, 117)}…` : json;
}

/**
 * What differs, before and after, for each path the engine says changed: the change itself, beside
 * its class, so a person approves what they can see. A path the documents don't both have a value
 * for (a whole new section) shows the engine's words only.
 */
export function ChangeDiff({
  before,
  after,
  changes,
  testId,
}: {
  before: Doc | null;
  after: Doc | null;
  changes: { path: string; summary: string; class: string }[];
  testId?: string;
}) {
  const paths = [...new Set(changes.map((c) => c.path))].filter((p) => p !== "*");
  const rows = paths
    .map((path) => ({ path, was: valueAt(before, path), now: valueAt(after, path) }))
    .filter((r) => JSON.stringify(r.was) !== JSON.stringify(r.now));
  if (rows.length === 0) return null;
  return (
    <div
      className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-3 gap-y-1 rounded-lg bg-page px-3 py-2 text-xs"
      data-testid={testId}
    >
      {rows.map((r) => (
        <div key={r.path} className="contents">
          <span className="font-mono text-ink-3">{r.path}</span>
          <span className="min-w-0 break-words">
            <span className="text-ink-3 line-through">{shown(r.was)}</span>
            {" → "}
            <span className="font-medium">{shown(r.now)}</span>
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * Unsaved changes: the engine's impact and the difference, a note for History, Discard and Save. At
 * a narrow window it is one line until opened, so it doesn't cover the field being edited. When the
 * version moved while editing, it says so and asks the person to review the difference first.
 */
export function SaveBar({ editor }: { editor: ConfigEditor }) {
  const {
    dirty,
    moved,
    preview,
    busy,
    setDraft,
    save,
    currentVersion,
    baseVersion,
    note,
    setNote,
  } = editor;
  const [open, setOpen] = useState(false);
  if (!dirty) return null;
  // The previous draft's answer is kept while the new one loads: never show or act on it.
  const fresh = preview.data && !preview.isPlaceholderData ? preview.data : null;
  const loosens = fresh?.impact?.class === "loosens";
  const invalid = fresh && !fresh.valid;
  const changes = fresh?.impact?.changes ?? [];
  return (
    <Panel needsYou className="sticky bottom-3 z-10 gap-2.5 shadow-lg" data-testid="save-bar">
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-2 min-[900px]:gap-2">
        <span className="font-semibold text-[13px] max-[899px]:hidden">Unsaved changes</span>
        {loosens && (
          <Chip tone="amber">
            Loosens<span className="max-[899px]:hidden">: waits for an approver</span>
          </Chip>
        )}
        {invalid && <Chip tone="amber">Not valid</Chip>}
        {!fresh && <span className="text-ink-3 text-xs">Classifying…</span>}
        <Button
          size="sm"
          variant="ghost"
          className="h-7 px-2 underline min-[900px]:hidden"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
        >
          {open ? "Hide" : `${changes.length || ""} ${changes.length === 1 ? "change" : "changes"}`}
        </Button>
        <span className="grow" />
        <Button
          size="sm"
          variant="ghost"
          className="px-2 max-[899px]:hidden"
          onClick={() => setDraft(null)}
          disabled={busy}
        >
          Discard
        </Button>
        <Button
          size="sm"
          onClick={() => void save()}
          disabled={busy || moved || !fresh?.valid}
          data-testid="config-save"
        >
          {busy ? "Saving…" : loosens ? "Send" : `Save v${currentVersion + 1}`}
          {!busy && loosens && <span className="max-[899px]:hidden"> for approval</span>}
        </Button>
      </div>
      {moved && (
        <div className="flex flex-wrap items-center gap-2 text-[13px]" data-testid="config-moved">
          <span className="min-w-[min(100%,280px)] flex-1">
            The policy changed while you were editing (v{baseVersion} → v{currentVersion}): review
            the difference below, then keep your changes on v{currentVersion}.
          </span>
          <Button size="sm" variant="outline" onClick={editor.rebase}>
            Keep my changes on v{currentVersion}
          </Button>
        </div>
      )}
      <div className={cn("flex flex-col gap-2", !open && !moved && "max-[899px]:hidden")}>
        {invalid && <div className="text-[13px]">Not valid: {fresh?.error}</div>}
        <div className="flex max-h-48 flex-col gap-2 overflow-y-auto">
          <ImpactList changes={changes} testId="impact" />
          <ChangeDiff
            before={editor.current?.policy ?? null}
            after={editor.draft}
            changes={changes}
            testId="impact-diff"
          />
        </div>
        <Input
          placeholder="Why (optional, shows in History)"
          value={note}
          aria-label="Why"
          onChange={(e) => setNote(e.target.value)}
        />
        <Button
          size="sm"
          variant="outline"
          className="w-fit min-[900px]:hidden"
          onClick={() => setDraft(null)}
          disabled={busy}
        >
          Discard changes
        </Button>
      </div>
    </Panel>
  );
}

/**
 * Asks before unsaved changes are lost: Done, another project, or leaving the page (the router's
 * blocker covers every navigation in the app).
 */
export function UnsavedGuard({ editor }: { editor: ConfigEditor }) {
  const blocker = useBlocker({ shouldBlockFn: () => editor.dirty, withResolver: true });
  return (
    <AlertDialog open={blocker.status === "blocked"} onOpenChange={(o) => !o && blocker.reset?.()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Discard your unsaved changes?</AlertDialogTitle>
          <AlertDialogDescription>
            Nothing has been saved. Leaving now drops them.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => blocker.reset?.()}>Keep editing</AlertDialogCancel>
          <AlertDialogAction onClick={() => blocker.proceed?.()}>Discard</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
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
  below,
  children,
}: {
  label: string;
  help?: string;
  /** A full-width line under the field (an override's note). */
  below?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="grid items-center gap-x-4 gap-y-1.5 border-line-soft border-b py-2.5 last:border-b-0 min-[900px]:grid-cols-[minmax(0,1fr)_auto]">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="font-medium text-[13px]">{label}</span>
        {help && <span className="text-ink-3 text-xs">{help}</span>}
      </div>
      <div className="flex flex-wrap items-center gap-2 min-[900px]:justify-end">{children}</div>
      {below && <div className="min-[900px]:col-span-2">{below}</div>}
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

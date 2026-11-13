// Editing a project's config in the desktop app (ADR 0370, 0610; ported from sf-app's
// config-editor): a draft over the current version, the save bar with the engine's classified impact
// (`config.preview`) and the small form pieces the Policy page uses. Saving is `config.save` with the
// version the draft was made from: a change that tightens or is neutral applies at once, one that
// loosens comes back `pending` and waits for an approver, who decides it with Touch ID
// (`PendingChanges`). The impact is the engine's, never worked out here.
import { Button } from "@software-factory/ui/components/button";
import { Input } from "@software-factory/ui/components/input";
import { cn } from "@software-factory/ui/lib/utils";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { XIcon } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { toast } from "sonner";
import { configQuery } from "../lib/factory-queries.ts";
import { OpError, op, read, submitKey } from "../lib/op.ts";
import {
  ChangeDiff,
  CharCount,
  ImpactChip,
  ImpactList,
  INSTRUCTIONS_MAX,
  LeaveGuard,
  Segmented,
  shown,
  valueAt,
} from "./config-fields.tsx";
import { Chip, Panel, SectionTitle } from "./shell-list.tsx";

export {
  ChangeDiff,
  CharCount,
  ImpactChip,
  ImpactList,
  INSTRUCTIONS_MAX,
  LeaveGuard,
  Segmented,
  shown,
  valueAt,
};

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

/**
 * The save button's words: a loosening is sent for approval, anything else saves the next version.
 * `short` drops "for approval" at a narrow window (tested).
 */
export function saveLabel(loosens: boolean, currentVersion: number) {
  return loosens
    ? { full: "Send for approval", short: "Send" }
    : { full: `Save v${currentVersion + 1}`, short: `Save v${currentVersion + 1}` };
}

/** How long after the last edit a draft is sent for classification. */
export const PREVIEW_DEBOUNCE_MS = 600;

/** `value`, once it has stopped changing for `ms`. */
export function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return settled;
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

  // Classified once typing stops (Cloudflare cost: every preview is a Worker request and D1
  // reads; a keystroke each would be thousands for one instructions box). Until then, "Classifying…".
  const settled = useDebounced(draft?.doc ?? null, PREVIEW_DEBOUNCE_MS);
  const typing = JSON.stringify(settled) !== JSON.stringify(draft?.doc ?? null);
  const query = useQuery({
    queryKey: ["config", projectId, "preview", settled],
    queryFn: () => read("config.preview", { projectId, policy: settled ?? {} }),
    enabled: dirty && !typing && !!settled,
    placeholderData: keepPreviousData,
  });
  // While typing or loading, the answer on screen is never an older draft's.
  const preview = { ...query, isPlaceholderData: query.isPlaceholderData || typing };

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
          {busy ? "Saving…" : saveLabel(loosens, currentVersion).short}
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
  return <LeaveGuard dirty={editor.dirty} />;
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

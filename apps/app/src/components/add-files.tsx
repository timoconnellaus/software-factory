// Adding files (spec wi-1, ADR 0310): the drop zone and picker, the paste listener and the pending
// rows with per-file progress or the reason a file was refused. Shared by the work item's
// Attachments card and the New work form.
import { cn } from "@software-factory/ui/lib/utils";
import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ACCEPT, filesFromClipboard, filesFromList } from "#/lib/attachments";

export interface Pending {
  key: string;
  name: string;
  progress: number;
  error: string | null;
}

/** Calls `onFiles` with the files of any paste on the page that carries files (not plain text). */
export function usePasteFiles(onFiles: (files: File[]) => void) {
  const handler = useRef(onFiles);
  handler.current = onFiles;
  useEffect(() => {
    const listener = (event: ClipboardEvent) => {
      const files = filesFromClipboard(event.clipboardData);
      if (files.length === 0) return;
      event.preventDefault();
      handler.current(files);
    };
    window.addEventListener("paste", listener);
    return () => window.removeEventListener("paste", listener);
  }, []);
}

/** The drop zone, picker button and pending/error rows shared by both forms. */
export function AddFiles({
  onFiles,
  pending,
  onDismiss,
}: {
  onFiles: (files: File[]) => void;
  pending: Pending[];
  onDismiss: (key: string) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  return (
    <>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: a drop target; the button inside is the keyboard path. */}
      <div
        className={cn(
          "rounded-md border border-dashed px-3 py-3 text-center text-muted-foreground text-xs transition-colors",
          over && "border-primary bg-primary/5 text-foreground",
        )}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes("Files")) return;
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          onFiles(filesFromList(e.dataTransfer.files));
        }}
        data-testid="attachment-drop"
      >
        Drop files, paste a screenshot, or{" "}
        <button
          type="button"
          className="underline"
          onClick={() => input.current?.click()}
          data-testid="attachment-pick"
        >
          choose files
        </button>
        <input
          ref={input}
          type="file"
          multiple
          accept={ACCEPT}
          className="hidden"
          onChange={(e) => {
            onFiles(filesFromList(e.target.files));
            e.target.value = "";
          }}
        />
      </div>
      {pending.map((p) => (
        <div key={p.key} className="grid gap-1 text-xs" data-testid="attachment-pending">
          <div className="flex items-center gap-2">
            <span className="min-w-0 truncate">{p.name}</span>
            {p.error && (
              <button
                type="button"
                className="ml-auto text-muted-foreground"
                aria-label={`Dismiss ${p.name}`}
                onClick={() => onDismiss(p.key)}
              >
                <X className="size-3" />
              </button>
            )}
          </div>
          {p.error ? (
            <div className="text-destructive">{p.error}</div>
          ) : (
            <div className="h-1 overflow-hidden rounded bg-muted">
              <div
                className="h-full bg-primary transition-[width]"
                style={{ width: `${Math.round(p.progress * 100)}%` }}
              />
            </div>
          )}
        </div>
      ))}
    </>
  );
}

export function usePending() {
  const [pending, setPending] = useState<Pending[]>([]);
  const update = (key: string, patch: Partial<Pending>) =>
    setPending((all) => all.map((p) => (p.key === key ? { ...p, ...patch } : p)));
  return {
    pending,
    add: (name: string, error: string | null = null) => {
      const key = crypto.randomUUID();
      setPending((all) => [...all, { key, name, progress: 0, error }]);
      return key;
    },
    update,
    remove: (key: string) => setPending((all) => all.filter((p) => p.key !== key)),
  };
}

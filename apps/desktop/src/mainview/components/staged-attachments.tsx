// Attachments on the New work form (spec wi-1): files picked, dropped or pasted before the work item
// exists are staged here and uploaded once `workItem.create` has made it.
// Ported from sf-app for spec 40 M3: the same, but the upload goes through the client door
// (lib/attachments.ts) instead of sf-app's upload endpoint.
import { Paperclip, X } from "lucide-react";
import { useState } from "react";
import { formatBytes, precheck, uploadAttachment } from "../lib/attachments.ts";
import { AddFiles, type Pending, usePasteFiles } from "./add-files.tsx";

/**
 * Attachments on the New work form: staged until the item exists. `files` and `onChange` are the
 * form's state; the form calls `uploadStaged` after `workItem.create`.
 */
export function StagedAttachments({
  files,
  onChange,
}: {
  files: File[];
  onChange: (files: File[]) => void;
}) {
  const [rejected, setRejected] = useState<Pending[]>([]);
  const stage = (incoming: File[]) => {
    const ok: File[] = [];
    const bad: Pending[] = [];
    for (const file of incoming) {
      const error = precheck(file);
      if (error) bad.push({ key: crypto.randomUUID(), name: file.name, progress: 0, error });
      else ok.push(file);
    }
    if (ok.length) onChange([...files, ...ok]);
    if (bad.length) setRejected((r) => [...r, ...bad]);
  };
  usePasteFiles(stage);
  return (
    <div className="grid gap-2" data-testid="staged-attachments">
      {files.map((f, i) => (
        <div
          key={`${f.name}-${f.size}-${f.lastModified}`}
          className="flex items-center gap-2 text-sm"
        >
          <Paperclip className="size-3.5 text-muted-foreground" />
          <span className="min-w-0 truncate">{f.name}</span>
          <span className="text-muted-foreground text-xs">{formatBytes(f.size)}</span>
          <button
            type="button"
            className="ml-auto text-muted-foreground"
            aria-label={`Don't attach ${f.name}`}
            onClick={() => onChange(files.filter((_, j) => j !== i))}
          >
            <X className="size-3.5" />
          </button>
        </div>
      ))}
      <AddFiles
        onFiles={stage}
        pending={rejected}
        onDismiss={(key) => setRejected((r) => r.filter((p) => p.key !== key))}
      />
    </div>
  );
}

/** Uploads the New work form's staged files to the item it just created; returns failures. */
export async function uploadStaged(workItemId: string, files: File[]): Promise<string[]> {
  const failures: string[] = [];
  for (const file of files) {
    const result = await uploadAttachment(workItemId, file);
    if (!result.ok) failures.push(`${file.name}: ${result.message}`);
  }
  return failures;
}

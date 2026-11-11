// The Attachments section of a work item (spec wi-1, ADR 0260): a list with thumbnails for images,
// size and uploader; add by picker, drag-and-drop or pasting a clipboard image anywhere on the page;
// per-file progress and the server's reason for a rejected file; remove with confirmation.
import { Button } from "@software-factory/ui/components/button";
import { Card } from "@software-factory/ui/components/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@software-factory/ui/components/dialog";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FileText, Paperclip, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { attachmentUrl, formatBytes, isImage, precheck, uploadAttachment } from "#/lib/attachments";
import { op } from "#/lib/op";
import { type Attachment, OpError } from "#/lib/ops";
import { attachmentsQuery } from "#/lib/queries";
import { AddFiles, usePasteFiles, usePending } from "./add-files.tsx";

/**
 * Uploads files to a work item one by one, tracking each one's progress; refused files stay listed
 * with the server's reason. Resolves once all have been tried.
 */
export async function uploadAll(
  workItemId: string,
  files: File[],
  track: ReturnType<typeof usePending>,
): Promise<number> {
  let uploaded = 0;
  for (const file of files) {
    const early = precheck(file);
    const key = track.add(file.name, early);
    if (early) continue;
    const result = await uploadAttachment(workItemId, file, {
      onProgress: (progress) => track.update(key, { progress }),
    });
    if (result.ok) {
      track.remove(key);
      uploaded++;
    } else {
      track.update(key, { error: result.message });
    }
  }
  return uploaded;
}

/** The Attachments card on a work item's page. Pasting a file anywhere on the page attaches it. */
export function Attachments({
  workItemId,
  meId,
  isAdmin = false,
}: {
  workItemId: string;
  meId: string;
  /** An org owner or admin may remove anyone's file. */
  isAdmin?: boolean;
}) {
  const query = useQuery(attachmentsQuery(workItemId));
  const queryClient = useQueryClient();
  const track = usePending();
  const [removing, setRemoving] = useState<Attachment | null>(null);

  async function add(files: File[]) {
    if (files.length === 0) return;
    const uploaded = await uploadAll(workItemId, files, track);
    if (uploaded > 0) {
      await queryClient.invalidateQueries({ queryKey: attachmentsQuery(workItemId).queryKey });
      await queryClient.invalidateQueries({ queryKey: ["workItem", workItemId, "timeline"] });
    }
  }
  usePasteFiles((files) => void add(files));

  async function remove(attachment: Attachment) {
    try {
      await op("workItem.attachment.remove", { attachmentId: attachment.id });
      toast.success(`Removed ${attachment.filename}`);
      await queryClient.invalidateQueries({ queryKey: attachmentsQuery(workItemId).queryKey });
    } catch (error) {
      toast.error(error instanceof OpError ? error.message : "Couldn't remove it");
    } finally {
      setRemoving(null);
    }
  }

  const list = query.data?.attachments ?? [];
  return (
    <Card className="gap-2 px-5 py-4" data-testid="attachments">
      <div className="flex items-center gap-2 font-semibold">
        <Paperclip className="size-4" />
        Attachments
        {list.length > 0 && (
          <span className="font-normal text-muted-foreground text-xs">{list.length}</span>
        )}
      </div>
      {query.error && (
        <div className="text-destructive text-sm">
          Couldn't load attachments: {query.error.message}
        </div>
      )}
      {list.map((a) => (
        <AttachmentRow
          key={a.id}
          attachment={a}
          canRemove={isAdmin || a.uploader.id === meId}
          onRemove={() => setRemoving(a)}
        />
      ))}
      <AddFiles
        onFiles={(files) => void add(files)}
        pending={track.pending}
        onDismiss={track.remove}
      />
      <Dialog open={!!removing} onOpenChange={(open) => !open && setRemoving(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove {removing?.filename}?</DialogTitle>
            <DialogDescription>
              The file is deleted for everyone, and runs from now on won't see it.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRemoving(null)}>
              Keep it
            </Button>
            <Button
              variant="destructive"
              onClick={() => removing && void remove(removing)}
              data-testid="attachment-remove-confirm"
            >
              Remove
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function AttachmentRow({
  attachment: a,
  canRemove,
  onRemove,
}: {
  attachment: Attachment;
  canRemove: boolean;
  onRemove: () => void;
}) {
  const url = attachmentUrl(a.id);
  return (
    <div className="flex items-center gap-3 text-sm" data-testid="attachment">
      <a
        href={url}
        target="_blank"
        rel="noreferrer noopener"
        className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded border bg-muted"
      >
        {isImage(a.contentType) ? (
          // The browser scales it down: no thumbnails are generated (out of scope in v1).
          <img src={url} alt="" loading="lazy" className="size-full object-cover" />
        ) : (
          <FileText className="size-4 text-muted-foreground" />
        )}
      </a>
      <div className="min-w-0 grow">
        <a
          href={url}
          target="_blank"
          rel="noreferrer noopener"
          className="block truncate hover:underline"
          title={a.filename}
        >
          {a.filename}
        </a>
        <div className="truncate text-muted-foreground text-xs">
          {formatBytes(a.sizeBytes)} · {a.uploader.name ?? a.uploader.id}
        </div>
      </div>
      {canRemove && (
        <button
          type="button"
          className="shrink-0 text-muted-foreground hover:text-foreground"
          aria-label={`Remove ${a.filename}`}
          onClick={onRemove}
        >
          <X className="size-4" />
        </button>
      )}
    </div>
  );
}

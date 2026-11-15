// A schedule's small form (Auto, .kim/mockups/auto-schedules.html): its name, the project, the
// item's title and body, how often (a segmented choice), the time, and the day for a weekly one.
// Times are in the schedule's zone, which starts as this Mac's: there is no zone picker.
import {
  DAY_NAMES,
  draftOf,
  EVERY_CHOICES,
  type FlowEvery,
  type FlowSchedule,
  parseTime,
  type ScheduleDraft,
  toInput,
  viewerTimeZone,
} from "@software-factory/client/flow-auto";
import { Button } from "@software-factory/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@software-factory/ui/components/dialog";
import { Input } from "@software-factory/ui/components/input";
import { Label } from "@software-factory/ui/components/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@software-factory/ui/components/select";
import { Textarea } from "@software-factory/ui/components/textarea";
import { ToggleGroup, ToggleGroupItem } from "@software-factory/ui/components/toggle-group";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { flowProjectsQuery, useFlowRefresh } from "../../lib/flow-queries.ts";
import { OpError, op, submitKey } from "../../lib/op.ts";

export function ScheduleDialog({
  orgId,
  schedule,
  open,
  onOpenChange,
}: {
  orgId: string;
  schedule: FlowSchedule | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const projects = useQuery(flowProjectsQuery(orgId));
  const list = projects.data?.projects ?? [];
  const refresh = useFlowRefresh(orgId);
  const [draft, setDraft] = useState<ScheduleDraft>(() =>
    draftOf(schedule, list[0]?.id ?? "", viewerTimeZone()),
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const set = (patch: Partial<ScheduleDraft>) => setDraft((d) => ({ ...d, ...patch }));
  // The first project, once the list has loaded, for a new schedule opened before it did.
  const projectId = draft.projectId || list[0]?.id || "";
  const minute = parseTime(draft.time)?.minute ?? 0;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const input = toInput(orgId, { ...draft, projectId }, schedule?.id);
    if ("problem" in input) {
      setError(input.problem);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await op("flow.schedule.save", input, { idempotencyKey: submitKey() });
      await refresh();
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof OpError || err instanceof Error ? err.message : "Couldn't save it.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={save} className="grid gap-4" data-testid="schedule-form">
          <DialogHeader>
            <DialogTitle>{schedule ? `Change ${schedule.name}` : "New schedule"}</DialogTitle>
            <DialogDescription>
              It makes an item in the project on a clock. The item then goes through the project's
              workflow like any other.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor="schedule-name">Name</Label>
            <Input
              id="schedule-name"
              value={draft.name}
              autoFocus
              maxLength={100}
              placeholder="Nightly triage"
              onChange={(e) => set({ name: e.target.value })}
            />
          </div>
          <div className="grid gap-1.5">
            <Label>Project</Label>
            <Select value={projectId} onValueChange={(v) => set({ projectId: v })}>
              <SelectTrigger className="w-full" data-testid="schedule-project">
                <SelectValue placeholder="Choose a project" />
              </SelectTrigger>
              <SelectContent>
                {list.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="schedule-title">The item's title</Label>
            <Input
              id="schedule-title"
              value={draft.title}
              maxLength={300}
              placeholder="Triage new customer feedback"
              onChange={(e) => set({ title: e.target.value })}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="schedule-body">The item's body</Label>
            <Textarea
              id="schedule-body"
              value={draft.body}
              rows={3}
              placeholder="What the item asks for (optional)"
              onChange={(e) => set({ body: e.target.value })}
            />
          </div>
          <div className="grid gap-1.5">
            <Label>How often</Label>
            <ToggleGroup
              type="single"
              variant="outline"
              size="sm"
              value={draft.every}
              onValueChange={(v) => v && set({ every: v as FlowEvery })}
              className="w-full"
              data-testid="schedule-every"
            >
              {EVERY_CHOICES.map((c) => (
                <ToggleGroupItem
                  key={c.value}
                  value={c.value}
                  className="text-[12.5px]"
                  data-testid={`every-${c.value}`}
                >
                  {c.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>
          <div className="flex gap-3">
            {draft.every === "week" && (
              <div className="grid flex-1 gap-1.5">
                <Label>Day</Label>
                <Select
                  value={String(draft.onDay)}
                  onValueChange={(v) => set({ onDay: Number(v) })}
                >
                  <SelectTrigger className="w-full" data-testid="schedule-day">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {/* Monday first, Sunday last. */}
                    {[1, 2, 3, 4, 5, 6, 0].map((d) => (
                      <SelectItem key={d} value={String(d)}>
                        {DAY_NAMES[d]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            {draft.every === "hour" ? (
              <div className="grid flex-1 gap-1.5">
                <Label htmlFor="schedule-minute">Minutes past the hour</Label>
                <Input
                  id="schedule-minute"
                  type="number"
                  min={0}
                  max={59}
                  value={minute}
                  onChange={(e) => {
                    const m = Math.min(59, Math.max(0, Math.trunc(Number(e.target.value) || 0)));
                    set({ time: `00:${String(m).padStart(2, "0")}` });
                  }}
                />
              </div>
            ) : (
              <div className="grid flex-1 gap-1.5">
                <Label htmlFor="schedule-time">Time</Label>
                <Input
                  id="schedule-time"
                  type="time"
                  value={draft.time}
                  onChange={(e) => set({ time: e.target.value })}
                />
              </div>
            )}
          </div>
          <p className="-mt-2 text-[12px] text-ink-faint" data-testid="schedule-zone">
            Times are in {draft.timeZone}.
          </p>
          {error && <p className="text-bad">{error}</p>}
          <DialogFooter>
            <Button type="submit" disabled={saving} data-testid="save-schedule">
              {schedule ? "Save" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// Auto (.kim/mockups/auto-schedules.html): Schedules, each making an item in a project on a clock,
// as a table (when it runs and next runs in plain words, what it last made or why it failed, an
// on/off switch, and Edit, Run now and Remove); and Triggers, which come from plugins.
import {
  everyText,
  type FlowSchedule,
  lastRun,
  nextText,
  viewerTimeZone,
} from "@software-factory/client/flow-auto";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@software-factory/ui/components/dropdown-menu";
import { Skeleton } from "@software-factory/ui/components/skeleton";
import { Switch } from "@software-factory/ui/components/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@software-factory/ui/components/table";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { EllipsisIcon, PlusIcon, ZapIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { flowSchedulesQuery } from "../../lib/flow-auto-queries.ts";
import { useFlowRefresh } from "../../lib/flow-queries.ts";
import { OpError, op, submitKey } from "../../lib/op.ts";
import { ScheduleDialog } from "./auto-form.tsx";
import { PageHeader } from "./parts.tsx";

export type AutoTab = "schedules" | "triggers";

/** The table's columns and their widths; "Makes" takes what is left. */
const COLUMNS = [
  ["Name", "w-[15%]"],
  ["When", "w-[17%]"],
  ["Project", "w-[13%]"],
  ["Makes", ""],
  ["Next", "w-[14%]"],
  ["Last", "w-[16%]"],
  ["", "w-[88px]"],
] as const;

const failed = (e: unknown, fallback: string) =>
  e instanceof OpError || e instanceof Error ? e.message : fallback;

export function AutoPage({
  orgId,
  tab,
  onTab,
}: {
  orgId: string;
  tab: AutoTab;
  onTab: (tab: AutoTab) => void;
}) {
  // null: closed; "new": a new schedule; otherwise the schedule being edited.
  const [editing, setEditing] = useState<FlowSchedule | "new" | null>(null);
  return (
    <main className="relative flex min-w-0 flex-1 flex-col" data-testid="auto-page">
      <PageHeader
        title="Auto"
        tabs={["Schedules", "Triggers"]}
        tab={tab === "triggers" ? "Triggers" : "Schedules"}
        onTab={(t) => onTab(t === "Triggers" ? "triggers" : "schedules")}
      >
        <span className="flex-1" />
        {tab === "schedules" && (
          <Button size="md" onClick={() => setEditing("new")} data-testid="new-schedule">
            <PlusIcon />
            New
          </Button>
        )}
      </PageHeader>
      <div className="min-h-0 flex-1 overflow-auto bg-board px-5 py-5">
        {tab === "triggers" ? (
          <Triggers orgId={orgId} />
        ) : (
          <Schedules orgId={orgId} onEdit={setEditing} />
        )}
      </div>
      <ScheduleDialog
        key={editing === null ? "closed" : editing === "new" ? "new" : editing.id}
        orgId={orgId}
        schedule={editing === "new" ? null : editing}
        open={editing !== null}
        onOpenChange={(open) => !open && setEditing(null)}
      />
    </main>
  );
}

function Schedules({ orgId, onEdit }: { orgId: string; onEdit: (s: FlowSchedule) => void }) {
  const schedules = useQuery(flowSchedulesQuery(orgId));
  const refresh = useFlowRefresh(orgId);
  const [removing, setRemoving] = useState<FlowSchedule | null>(null);
  const zone = viewerTimeZone();
  const list = schedules.data?.schedules ?? [];

  async function remove(s: FlowSchedule) {
    try {
      await op(
        "flow.schedule.delete",
        { orgId, scheduleId: s.id },
        { idempotencyKey: submitKey() },
      );
      await refresh();
    } catch (error) {
      toast.error(failed(error, "Couldn't remove the schedule"));
    }
  }

  if (schedules.error)
    return <p className="text-bad">Couldn't load the schedules. {schedules.error.message}</p>;
  if (!schedules.data) return <Skeleton className="h-28 w-full max-w-[980px]" />;
  if (list.length === 0)
    return (
      <div
        className="grid max-w-[560px] justify-items-start gap-2 pt-6"
        data-testid="schedules-empty"
      >
        <ZapIcon className="size-5 text-ink-faint" />
        <p className="font-medium">No schedules yet.</p>
        <p className="text-ink-muted">
          A schedule makes an item in a project on a clock, such as every weekday at 09:00. The item
          then goes through its project's workflow like any other.
        </p>
      </div>
    );
  return (
    <>
      <div className="max-w-[1080px] overflow-hidden rounded-[10px] border border-line bg-panel">
        {/* Fixed widths, so a long title or error wraps and the switch stays in view. */}
        <Table className="table-fixed text-[13px]" data-testid="schedule-table">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              {COLUMNS.map(([h, width]) => (
                <TableHead
                  key={h}
                  className={`${width} px-3.5 font-medium text-[11.5px] text-ink-faint`}
                >
                  {h}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.map((s) => (
              <ScheduleRow
                key={s.id}
                orgId={orgId}
                schedule={s}
                zone={zone}
                onEdit={() => onEdit(s)}
                onRemove={() => setRemoving(s)}
              />
            ))}
          </TableBody>
        </Table>
      </div>
      <AlertDialog open={!!removing} onOpenChange={(open) => !open && setRemoving(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {removing?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              It stops making items. The items it already made stay where they are.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => removing && void remove(removing)}
              data-testid="confirm-remove-schedule"
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function ScheduleRow({
  orgId,
  schedule: s,
  zone,
  onEdit,
  onRemove,
}: {
  orgId: string;
  schedule: FlowSchedule;
  zone: string;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const refresh = useFlowRefresh(orgId);
  const [busy, setBusy] = useState(false);
  const last = lastRun(s);

  async function toggle(enabled: boolean) {
    setBusy(true);
    try {
      await op(
        "flow.schedule.save",
        {
          orgId,
          scheduleId: s.id,
          projectId: s.projectId,
          name: s.name,
          title: s.title,
          body: s.body,
          every: s.every,
          atMinute: s.atMinute,
          atHour: s.atHour,
          onDay: s.onDay,
          timeZone: s.timeZone,
          enabled,
        },
        { idempotencyKey: submitKey() },
      );
    } catch (error) {
      toast.error(failed(error, "Couldn't change the schedule"));
    } finally {
      await refresh();
      setBusy(false);
    }
  }

  async function runNow() {
    setBusy(true);
    try {
      await op(
        "flow.schedule.runNow",
        { orgId, scheduleId: s.id },
        { idempotencyKey: submitKey() },
      );
      toast.success(`${s.name} made its item`);
    } catch (error) {
      toast.error(failed(error, "Couldn't run the schedule"));
    } finally {
      await refresh();
      setBusy(false);
    }
  }

  return (
    <TableRow
      className="cursor-default"
      data-testid="schedule-row"
      data-enabled={s.enabled ? "true" : "false"}
    >
      <TableCell className="whitespace-normal break-words px-3.5 py-2.5 font-medium">
        {s.name}
      </TableCell>
      <TableCell className="whitespace-normal px-3.5 text-ink-muted">
        {everyText(s, zone)}
      </TableCell>
      <TableCell className="whitespace-normal break-words px-3.5">
        {s.projectName ?? "A deleted project"}
      </TableCell>
      <TableCell className="whitespace-normal break-words px-3.5 text-ink-muted">
        {s.title}
      </TableCell>
      <TableCell className="whitespace-normal px-3.5 text-ink-muted" data-testid="schedule-next">
        {nextText(s)}
      </TableCell>
      <TableCell className="whitespace-normal break-words px-3.5" data-testid="schedule-last">
        {last.kind === "item" ? (
          <Link
            to="/flow/$orgId/p/$projectId"
            params={{ orgId, projectId: last.projectId }}
            search={{ item: last.itemId }}
            className="text-ok hover:underline"
          >
            Made {last.key}
          </Link>
        ) : last.kind === "error" ? (
          <span className="text-bad">Failed: {last.text}</span>
        ) : (
          <span className="text-ink-faint">Not run yet</span>
        )}
      </TableCell>
      <TableCell className="w-[88px] px-3.5">
        <span className="flex items-center justify-end gap-1">
          <Switch
            checked={s.enabled}
            disabled={busy}
            onCheckedChange={(on) => void toggle(on)}
            aria-label={`${s.name} on`}
            data-testid="schedule-switch"
          />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-md"
                aria-label={`More for ${s.name}`}
                data-testid="schedule-menu"
              >
                <EllipsisIcon />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={onEdit} data-testid="edit-schedule">
                Edit
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={busy}
                onSelect={() => void runNow()}
                data-testid="run-schedule"
              >
                Run now
              </DropdownMenuItem>
              <DropdownMenuItem
                variant="destructive"
                onSelect={onRemove}
                data-testid="remove-schedule"
              >
                Remove
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </span>
      </TableCell>
    </TableRow>
  );
}

/** Triggers are plugins' own: the plugin list doesn't say yet which define one, or their URLs. */
function Triggers({ orgId }: { orgId: string }) {
  return (
    <p className="max-w-[640px] text-ink-muted" data-testid="triggers-note">
      Triggers come from plugins: a plugin can start work when an outside system calls it. See them
      in{" "}
      <Link
        to="/flow/$orgId/plugins"
        params={{ orgId }}
        className="text-ink underline underline-offset-2"
      >
        Plugins
      </Link>
      .
    </p>
  );
}

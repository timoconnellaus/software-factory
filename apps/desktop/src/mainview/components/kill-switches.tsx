// Kill switches (ADR 0044, 0610): the org's and each project's, on or off with the reason. Turning
// one on is a plain call (anyone may stop work, from anywhere); turning one off lets work resume,
// so it is a decision with Touch ID (`decide()`), never from a software key.
import type { Project } from "@software-factory/client/ops";
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
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { killSwitchesQuery } from "../lib/factory-queries.ts";
import { OpError, op, submitKey } from "../lib/op.ts";
import { usePolicyDecide } from "../lib/policy-decide.ts";
import { CannotApproveYet, useCanDecide } from "./cannot-approve.tsx";
import { Cell, Row, TablePanel, WIDE } from "./data-table.tsx";
import { Chip, SectionTitle } from "./shell-list.tsx";

type Target = { scope: "org" | "project"; id: string; name: string; on: boolean };

export function KillSwitches({
  orgId,
  orgName,
  projects,
}: {
  orgId: string;
  orgName: string;
  projects: Project[];
}) {
  const switches = useQuery(killSwitchesQuery(orgId));
  const [target, setTarget] = useState<Target | null>(null);
  const [reason, setReason] = useState("");
  const { run, pending } = usePolicyDecide();
  const canDecide = useCanDecide();
  const queryClient = useQueryClient();
  const of = (id: string) => switches.data?.projects.find((p) => p.projectId === id);
  const rows: (Target & { reason: string | null })[] = [
    {
      scope: "org",
      id: orgId,
      name: `${orgName} (every project)`,
      on: !!switches.data?.org?.on,
      reason: switches.data?.org?.reason ?? null,
    },
    ...projects.map((p) => ({
      scope: "project" as const,
      id: p.id,
      name: p.name,
      on: !!of(p.id)?.on,
      reason: of(p.id)?.reason ?? null,
    })),
  ];
  const anyOn = rows.some((r) => r.on);
  async function turnOn(t: Target) {
    try {
      await op(
        "killSwitch.set",
        { scope: t.scope, id: t.id, on: true, ...(reason.trim() ? { reason: reason.trim() } : {}) },
        { idempotencyKey: submitKey() },
      );
      toast.success(`Stopped: ${t.name}`);
    } catch (error) {
      toast.error(error instanceof OpError ? error.message : String(error));
    } finally {
      await queryClient.invalidateQueries({ queryKey: ["killSwitches"] });
    }
  }
  return (
    <section className="flex flex-col gap-2" data-testid="kill-switches">
      <SectionTitle note="On, the covered work pauses and its runs stop; people can still decide gates.">
        Kill switches
      </SectionTitle>
      {anyOn && <CannotApproveYet />}
      <TablePanel head={["Where", "State", { label: "Why", className: WIDE }, ""]}>
        {rows.map((r) => (
          <Row key={`${r.scope}:${r.id}`}>
            <Cell className="font-medium">{r.name}</Cell>
            <Cell>
              {r.on ? <Chip tone="amber">On</Chip> : <span className="text-ink-3">Off</span>}
            </Cell>
            <Cell className={`whitespace-normal text-ink-3 ${WIDE}`}>{r.reason ?? ""}</Cell>
            <Cell className="text-right">
              <Button
                size="sm"
                variant={r.on ? "default" : "outline"}
                className="h-7"
                disabled={pending !== null || (r.on && !canDecide)}
                onClick={() => {
                  setReason("");
                  setTarget(r);
                }}
              >
                {r.on ? "Turn off" : "Turn on"}
              </Button>
            </Cell>
          </Row>
        ))}
      </TablePanel>
      <AlertDialog open={target !== null} onOpenChange={(o) => !o && setTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {target?.on ? `Let ${target.name} resume?` : `Stop ${target?.name}?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {target?.on
                ? "Its paused work resumes. Touch ID confirms it."
                : "Its work pauses at the next step and its runs stop, until a person turns it off."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {!target?.on && (
            <Input
              aria-label="Why"
              placeholder="Why (optional)"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={async () => {
                const t = target;
                setTarget(null);
                if (!t) return;
                if (t.on) {
                  await run(
                    "killSwitch.set",
                    { scope: t.scope, id: t.id, on: false },
                    `Resumed: ${t.name}`,
                  );
                  await queryClient.invalidateQueries({ queryKey: ["killSwitches"] });
                } else await turnOn(t);
              }}
            >
              {target?.on ? "Turn off" : "Turn on"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

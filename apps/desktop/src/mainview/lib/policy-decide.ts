// Policy decisions from the desktop (ADR 0610): org workflow and agent saves, org rollbacks,
// adopting projects' workflows, a looser override, a kill switch off. Each goes through `decide()`
// (a presence challenge, Touch ID showing the engine's summary, then the call with the proof), never
// `op()`. A software key's refusal is said plainly; a cancelled prompt decides nothing; a save that
// loosens waits for an org admin.
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { checkForUpdates, isSoftwareKeyRefusal, SOFTWARE_KEY_TEXT } from "./decisions.tsx";
import { decide, OpError, submitKey } from "./op.ts";

type PolicyOp =
  | "workflow.save"
  | "workflow.createFromTemplate"
  | "workflow.archive"
  | "agent.save"
  | "orgConfig.rollback"
  | "orgConfig.adoptProjectWorkflows"
  | "override.approve"
  | "killSwitch.set"
  | "approval.decide";

/** Runs one policy decision with a pending state, a toast and a refresh of the org's config. */
export function usePolicyDecide() {
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<string | null>(null);
  async function run(
    op: PolicyOp,
    input: Record<string, unknown>,
    done: string,
    tag: string = op,
  ): Promise<unknown | null> {
    setPending(tag);
    try {
      // biome-ignore lint/suspicious/noExplicitAny: one helper for several operations' inputs; each caller builds its own.
      const out = await decide(op as any, input as any, { idempotencyKey: submitKey() });
      toast.success(done);
      return out;
    } catch (error) {
      if (error instanceof OpError && error.code === "pending") {
        toast.success("This loosens the org's workflows, so it waits for an org admin.");
      } else if (error instanceof OpError && error.code === "cancelled") {
        toast("Cancelled: nothing was decided");
      } else if (isSoftwareKeyRefusal(error)) {
        toast.error(SOFTWARE_KEY_TEXT, {
          duration: 15_000,
          action: { label: "Check for updates", onClick: () => void checkForUpdates() },
        });
      } else {
        toast.error(error instanceof Error ? error.message : String(error), { duration: 15_000 });
      }
      return null;
    } finally {
      setPending(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["orgConfig"] }),
        queryClient.invalidateQueries({ queryKey: ["workflows"] }),
        queryClient.invalidateQueries({ queryKey: ["workflow"] }),
        queryClient.invalidateQueries({ queryKey: ["config"] }),
        queryClient.invalidateQueries({ queryKey: ["inbox"] }),
      ]);
    }
  }
  return { run, pending };
}

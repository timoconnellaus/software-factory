// How the merge gate words a review packet (spec 41, design InboxMerge/ItemReview): the headline,
// the chips under it and each criterion met or not, as main's verify run reports it (spec 51 PR B
// brings criteria proven by checks the factory runs). Pure, from the stored packet only.
import {
  checkCounts,
  type ParsedPacket,
  packetCounts,
  packetExecuted,
  packetProven,
} from "@software-factory/client/packet";
import type { Status } from "@software-factory/ui/components/status-dot";

const WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
const count = (n: number) => WORDS[n] ?? String(n);

export function verdictHeadline(p: ParsedPacket): { text: string; status: Status } {
  const c = packetCounts(p);
  const missing = c.total - c.met;
  if (p.verdict === "fail") return { text: "Failed verify", status: "failed" };
  // Declared checks the runner could not run (ADR 0501, fourth review): not a pass to merge on.
  const executed = packetExecuted(p);
  const notRun = executed && !executed.waived ? executed.notRun.length : 0;
  if (notRun > 0) {
    return {
      text: `Passed, but ${count(notRun)} ${notRun === 1 ? "check" : "checks"} could not be run`,
      status: "waiting",
    };
  }
  if (missing === 0) return { text: "Passed", status: "done" };
  return {
    text: `Passed, with ${count(missing)} ${missing === 1 ? "criterion" : "criteria"} not met`,
    status: "waiting",
  };
}

export function verdictChips(p: ParsedPacket): { label: string; status: Status }[] {
  const c = packetCounts(p);
  const checks = checkCounts(p);
  const chips: { label: string; status: Status }[] = [
    {
      // GitHub's CI, or what the reviewer reported: never the factory's own declared checks, whose
      // state is the proof chip below ("No checks set up" / "Proven N of M").
      label: checks.total
        ? `${checks.source === "ci" ? "CI" : "Checks"} ${checks.passed} of ${checks.total}`
        : checks.source === "ci"
          ? "No CI reported"
          : "No checks reported",
      status: checks.failed ? "failed" : checks.total ? "done" : "idle",
    },
    {
      label:
        c.total === c.met
          ? `Criteria ${c.met} met`
          : `Criteria ${c.met} met, ${c.total - c.met} not`,
      status: c.total === c.met ? "done" : "waiting",
    },
  ];
  // Spec 51 (ADR 0501): how many criteria an executed check proves. With nothing set up that could
  // prove one, the chip says that instead of "0 of N" (the owner's decision, 2026-11-13).
  const proven = packetProven(p);
  if (proven?.checksSetUp === false) chips.push({ label: "No checks set up", status: "idle" });
  else if (proven && proven.total > 0) {
    chips.push({
      label: `Proven ${proven.proven} of ${proven.total}`,
      status: proven.proven === proven.total ? "done" : "waiting",
    });
  }
  if (p.reviewer) {
    chips.push(
      p.reviewer.verdict === "approve"
        ? { label: "Reviewer approves", status: "done" }
        : { label: "Reviewer asks for changes", status: "failed" },
    );
  }
  chips.push(
    p.riskFlags.length
      ? {
          label: `${p.riskFlags.length} risk ${p.riskFlags.length === 1 ? "flag" : "flags"}`,
          status: "waiting",
        }
      : { label: "No risk flags", status: "idle" },
  );
  return chips;
}

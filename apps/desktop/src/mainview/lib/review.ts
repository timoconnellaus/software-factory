// How the merge gate words a review packet (spec 41, design InboxMerge/ItemReview): the headline,
// the chips under it and each criterion as proven or not. Pure, from the stored packet only.
import { checkCounts, packetCounts, type ParsedPacket } from "@software-factory/client/packet";
import type { Status } from "@software-factory/ui/components/status-dot";

const WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
const count = (n: number) => WORDS[n] ?? String(n);

export function verdictHeadline(p: ParsedPacket): { text: string; status: Status } {
  const c = packetCounts(p);
  const missing = c.total - c.met;
  if (p.verdict === "fail") return { text: "Failed verify", status: "failed" };
  if (missing === 0) return { text: "Passed", status: "done" };
  return {
    text: `Passed, with ${count(missing)} ${missing === 1 ? "criterion" : "criteria"} not proven`,
    status: "waiting",
  };
}

export function verdictChips(p: ParsedPacket): { label: string; status: Status }[] {
  const c = packetCounts(p);
  const checks = checkCounts(p);
  const chips: { label: string; status: Status }[] = [
    {
      label: checks.total ? `Checks ${checks.passed} of ${checks.total}` : "No checks reported",
      status: checks.failed ? "failed" : checks.total ? "done" : "idle",
    },
    {
      label:
        c.total === c.met
          ? `Criteria ${c.met} proven`
          : `Criteria ${c.met} proven, ${c.total - c.met} not`,
      status: c.total === c.met ? "done" : "waiting",
    },
  ];
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

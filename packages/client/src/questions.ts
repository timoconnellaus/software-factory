// Planning questions (ADR 0042): which answers to offer, and which can be bulk-accepted.
import { isSensitiveQuestion } from "@software-factory/runner-contract";
import type { WorkItemDetail } from "./ops.ts";

type Question = WorkItemDetail["questions"][number];

/** The answers to offer as buttons: the recommendation first, then the default, then the rest. */
export function answerChoices(q: {
  options: string[];
  defaultAnswer: string | null;
  recommendation: string | null;
}): { answer: string; tag: "recommended" | "default" | null }[] {
  const out: { answer: string; tag: "recommended" | "default" | null }[] = [];
  const add = (answer: string | null, tag: "recommended" | "default" | null) => {
    if (!answer || out.some((o) => o.answer === answer)) return;
    out.push({ answer, tag });
  };
  add(q.recommendation, "recommended");
  add(q.defaultAnswer, "default");
  for (const o of q.options) add(o, null);
  return out;
}

/** Security & privacy and irreversible questions are never bulk-accepted (ADR 0042). */
export function bulkAcceptable(q: Question): boolean {
  return q.status === "open" && q.defaultAnswer !== null && !isSensitiveQuestion(q);
}

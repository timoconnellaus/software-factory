// How a planning question card reads (spec 41, design ItemPlan and PlanFocus): the recommended
// option, whether the form still holds it (the primary button then says "Accept recommended", so
// one click answers), and the tag an answered row carries. Presentation only: everything comes from
// `planning.get` as main returns it today.

import type { PlanningQuestion } from "@software-factory/client/planning";

type Q = Pick<PlanningQuestion, "defaultValues" | "defaultAnswer" | "recommendation">;

/** The values the planner recommends: its default values, else the recommendation or default text. */
export function recommendedValues(q: Q): string[] {
  if (q.defaultValues?.length) return q.defaultValues;
  const text = q.recommendation ?? q.defaultAnswer;
  return text ? [text] : [];
}

/** Whether the form holds exactly the recommendation, with nothing typed in "Other". */
export function holdsRecommendation(q: Q, values: string[], other: string): boolean {
  const rec = recommendedValues(q);
  if (!rec.length || other.trim()) return false;
  const a = [...values].map((v) => v.trim()).sort();
  const b = [...rec].map((v) => v.trim()).sort();
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** An answered row's tag: the default kept, or changed (by you, when you answered it). */
export function answeredTag(
  q: Pick<PlanningQuestion, "acceptedDefault" | "answer" | "defaultAnswer" | "answeredBy">,
  me: string | null,
): { label: string; changed: boolean } {
  const changed = !q.acceptedDefault && q.answer !== q.defaultAnswer;
  if (!changed) return { label: "default", changed: false };
  return { label: me && q.answeredBy === me ? "changed by you" : "changed", changed: true };
}

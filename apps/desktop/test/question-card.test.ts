// The planning question card's wording (spec 41, design ItemPlan and PlanFocus): the recommended
// option is preselected, the primary button says "Accept recommended" while the form holds it (one
// click answers), and answered rows say "default" or "changed by you". The questions come from the
// screenshot harness's `planning.get`, shaped as main's operation returns them.
import type { PlanningView } from "@software-factory/client/planning";
import { describe, expect, it } from "vitest";
import { ANSWERS } from "../screenshots/fixtures.ts";
import {
  answeredTag,
  holdsRecommendation,
  recommendedValues,
} from "../src/mainview/lib/question-card.ts";

const get = ANSWERS["planning.get"];
if (!get) throw new Error("the harness has no planning.get");
const view: PlanningView = get({ workItemId: "wi_12" });
const byNumber = (n: number) => {
  const q = view.questions.find((x) => x.number === n);
  if (!q) throw new Error(`no Q${n}`);
  return q;
};

describe("the planning question card", () => {
  it("recommends the planner's default values", () => {
    const q = byNumber(6);
    expect(q.kind).toBe("single-choice");
    expect(recommendedValues(q)).toEqual(["Show a notice on the item, change nothing"]);
    expect(
      recommendedValues({ defaultValues: null, defaultAnswer: "A", recommendation: null }),
    ).toEqual(["A"]);
    expect(
      recommendedValues({ defaultValues: null, defaultAnswer: null, recommendation: null }),
    ).toEqual([]);
  });

  it("offers Accept recommended only while the form holds the recommendation", () => {
    const q = byNumber(6);
    const rec = recommendedValues(q);
    expect(holdsRecommendation(q, rec, "")).toBe(true);
    expect(holdsRecommendation(q, ["Send the item back to planning"], "")).toBe(false);
    expect(holdsRecommendation(q, rec, "something else")).toBe(false);
    expect(
      holdsRecommendation(
        { defaultValues: ["b", "a"], defaultAnswer: null, recommendation: null },
        ["a", "b"],
        "",
      ),
    ).toBe(true);
    expect(
      holdsRecommendation(
        { defaultValues: null, defaultAnswer: null, recommendation: null },
        [],
        "",
      ),
    ).toBe(false);
  });

  it("tags an answered row default or changed by you", () => {
    expect(answeredTag(byNumber(1), "usr_owner")).toEqual({ label: "default", changed: false });
    expect(answeredTag(byNumber(3), "usr_owner")).toEqual({
      label: "changed by you",
      changed: true,
    });
    expect(answeredTag(byNumber(3), "usr_other")).toEqual({ label: "changed", changed: true });
  });
});

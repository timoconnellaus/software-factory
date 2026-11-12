// Review of #90: mockups aren't framed in the desktop app until the Electrobun bridge probe has run.
// With the flag off (the default), a mockup is a titled note: no iframe, nothing of the planner's.
import type { PlanningView } from "@software-factory/client/planning";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MockupFrame, mockupsEnabled } from "../src/mainview/components/planning-visuals.tsx";

const artifact = {
  id: "art_a",
  kind: "mockup",
  title: "A: GitHub connection",
  description: null,
  revision: 1,
  keep: false,
  controls: [],
  size: 10,
} as unknown as PlanningView["artifacts"][number];

describe("mockups in the desktop app", () => {
  it("are off by default, and then frame nothing", () => {
    expect(mockupsEnabled()).toBe(false);
    const html = renderToStaticMarkup(
      <MockupFrame workItemId="wi" artifact={artifact} fit={300} />,
    );
    expect(html).not.toContain("<iframe");
    expect(html).toContain("mockups are not enabled in this app yet");
  });
});

// The babysitter's resolution at the reopened merge gate (spec 53, decision 1): only the resolution
// when it was read in full, loud when it wasn't, nothing extra on an ordinary gate (the packet's
// whole diff is the review). The panel as the Review tab renders it, from the fixtures' #13 (at its
// merge gate); the item page itself doesn't server-render (its media queries need a window).
import type { OpOutput } from "@software-factory/client/ops";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ANSWERS } from "../screenshots/fixtures.ts";
import { ResolutionPanel } from "../src/mainview/components/resolution.tsx";
import { textOf } from "./route-harness.tsx";

vi.mock("../src/mainview/bridge.ts", () => import("./bridge-stub.ts"));

type Detail = OpOutput<"workItem.get">;
type Resolution = NonNullable<Detail["babysitResolution"]>;

/** #13 (at its merge gate in the fixtures) with this resolution on its head. */
function withResolution(r: Partial<Resolution> | null) {
  return (input: { workItemId: string }) => {
    const d = (ANSWERS["workItem.get"] as (i: { workItemId: string }) => Detail)(input);
    const head = d.item.headSha ?? "9c41e07d2b";
    return {
      ...d,
      babysitResolution: r && {
        sha: head,
        status: "clean" as const,
        reason: null,
        itemHead: "4d1c9e2a7b",
        main: "b7e0f31c55",
        files: [],
        outside: [],
        notShown: 0,
        patchBase: "itemHead" as const,
        ...r,
      },
    };
  };
}

const review = async (r: Partial<Resolution> | null) =>
  renderToString(
    <QueryClientProvider client={new QueryClient()}>
      <ResolutionPanel detail={withResolution(r)({ workItemId: "wi_13" })} />
    </QueryClientProvider>,
  );

describe("the resolution at the reopened merge gate", () => {
  it("lists only the resolution: the conflict, which side it took, and a flagged file outside it", async () => {
    const html = await review({
      files: [
        {
          path: "src/verify.ts",
          previousPath: null,
          conflicted: true,
          took: "neither",
          note: null,
          patchOmitted: false,
          patchTruncated: false,
        },
        {
          path: "src/api.ts",
          previousPath: null,
          conflicted: false,
          took: "item",
          note: "differs from the default branch's change, which a merge would take",
          patchOmitted: false,
          patchTruncated: false,
        },
      ],
      outside: ["src/api.ts"],
      notShown: 2,
    });
    expect(html).toContain('data-testid="resolution"');
    const text = textOf(html);
    expect(text).toContain("The resolution");
    expect(text).toContain("src/verify.ts");
    expect(text).toContain("Took neither side: new content");
    expect(text).toContain("1 file outside the conflict differs from a plain merge");
    expect(text).toContain("differs from the default branch's change");
    expect(text).toContain("2 more files aren't listed");
  });

  it("is loud when the resolution isn't a plain merge, or couldn't be read in full: review the whole diff", async () => {
    for (const [status, reason, says] of [
      [
        "unclean",
        "the item and the default branch have more than one merge base",
        "isn't a plain merge",
      ],
      ["incomplete", "too large to read in full", "couldn't be read in full"],
      ["failed", "GitHub couldn't be read to find the merge base", "couldn't be read"],
    ] as const) {
      const html = await review({ status, reason });
      expect(html).toContain('data-testid="resolution-unreadable"');
      const text = textOf(html);
      expect(text).toContain("Review the whole diff, not only the resolution");
      expect(text).toContain(says);
      expect(text).toContain(reason);
    }
  });

  it("adds nothing to an ordinary merge gate: the packet's whole diff is the review", async () => {
    const html = await review(null);
    expect(html).not.toContain('data-testid="resolution"');
    // Nor anywhere but a pending merge gate.
    const d = withResolution({})({ workItemId: "wi_13" });
    const decided = { ...d, gates: d.gates.filter((g) => g.kind !== "merge") };
    expect(
      renderToString(
        <QueryClientProvider client={new QueryClient()}>
          <ResolutionPanel detail={decided} />
        </QueryClientProvider>,
      ),
    ).not.toContain('data-testid="resolution"');
  });
});

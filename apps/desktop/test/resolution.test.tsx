// The babysitter's resolution at the reopened merge gate (spec 53, decision 1; #201 review): only
// the resolution when it was read in full; loud, with the full diff, when it wasn't or couldn't be
// shown at all; nothing extra on an ordinary gate. Patches only for the head shown. In the Inbox, a
// resolution that isn't clean can't be merged from the card.
import type { OpOutput } from "@software-factory/client/ops";
import { parsePacket } from "@software-factory/client/packet";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { RESOLUTION_RULE_CASES } from "../../../packages/core/test/fixtures/resolution-rule-cases.ts";
import { ANSWERS } from "../screenshots/fixtures.ts";
import {
  Patch,
  ResolutionPanel,
  resolutionNeedsFullDiff,
  resolutionView,
} from "../src/mainview/components/resolution.tsx";
import { MergeDecision } from "../src/mainview/components/review-parts.tsx";
import { renderPage, textOf } from "./route-harness.tsx";

vi.mock("../src/mainview/bridge.ts", () => import("./bridge-stub.ts"));

type Detail = OpOutput<"workItem.get">;
type Resolution = NonNullable<Detail["babysitResolution"]>;
type File = Resolution["files"][number];

const base = (input: { workItemId: string }) =>
  (ANSWERS["workItem.get"] as (i: { workItemId: string }) => Detail)(input);

/** #13 (at its merge gate in the fixtures) with this resolution on its head, and the marker. */
function withResolution(r: Partial<Resolution> | null, expected = r !== null) {
  return (input: { workItemId: string }): Detail => {
    const d = base(input);
    const head = d.item.headSha ?? "9c41e07d2b";
    return {
      ...d,
      resolutionExpected: expected,
      babysitResolution: r && {
        sha: head,
        status: "clean" as const,
        reason: null,
        itemHead: "4d1c9e2a7b",
        main: "b7e0f31c55",
        files: [],
        outside: [],
        outsideNotShown: 0,
        notShown: 0,
        patchBase: "itemHead" as const,
        ...r,
      },
    };
  };
}

const file = (over: Partial<File> = {}): File => ({
  path: "src/verify.ts",
  previousPath: null,
  conflicted: true,
  took: "neither",
  note: null,
  patchOmitted: false,
  patchTruncated: false,
  ...over,
});

const render = (node: React.ReactNode) =>
  renderToString(<QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>);

const panel = (d: Detail) => render(<ResolutionPanel detail={d} />);
const review = (r: Partial<Resolution> | null, expected?: boolean) =>
  panel(withResolution(r, expected)({ workItemId: "wi_13" }));

describe("the resolution at the reopened merge gate", () => {
  it("lists only the resolution: the conflict, which side it took, chips, a rename, and flagged files outside it", () => {
    const html = review({
      files: [
        file(),
        file({
          path: "src/api.ts",
          previousPath: "src/old-api.ts",
          conflicted: false,
          took: "item",
          note: "differs from the default branch's change, which a merge would take",
          patchOmitted: true,
        }),
        file({ path: "src/big.ts", patchTruncated: true }),
      ],
      outside: ["src/api.ts", "src/elsewhere.ts"],
      outsideNotShown: 3,
      notShown: 1,
    });
    expect(html).toContain('data-testid="resolution"');
    const text = textOf(html);
    expect(text).toContain("src/old-api.ts → src/api.ts");
    expect(text).toContain("Took neither side: new content");
    expect(text).toContain("no patch");
    expect(text).toContain("patch clipped");
    // Every file outside the conflict counts, the unlisted ones are named, past the cap counted.
    expect(text).toContain("5 files outside the conflict differ from a plain merge");
    expect(text).toContain("Also outside the conflict (not listed above):");
    expect(text).toContain("src/elsewhere.ts");
    expect(text).toContain("and 3 more.");
    expect(text).toContain("1 more file isn't listed");
    expect(html).toContain('data-testid="resolution-full-diff"');
  });

  it("is loud when the resolution isn't a plain merge, or couldn't be read, saying 'review the whole diff' once", () => {
    for (const [status, reason, says] of [
      [
        "unclean",
        "the item and the default branch have more than one merge base",
        "isn't a plain merge",
      ],
      ["incomplete", "too large to read in full", "couldn't be read in full"],
      ["failed", "GitHub couldn't be read to find the merge base", "couldn't be read"],
    ] as const) {
      const html = review({ status, reason });
      expect(html).toContain('data-testid="resolution-unreadable"');
      const text = textOf(html);
      expect(text).toContain("Review the whole diff, not only the resolution");
      expect(text).toContain(says);
      expect(text).toContain(reason);
      expect(text.match(/review the whole diff/gi)).toHaveLength(1);
      // The checks' verdict below isn't about the resolution: said where the warning is.
      expect(text).toContain("say nothing about whether the conflict was resolved");
    }
  });

  it("is loud when the engine reopened the gate for a resolution it couldn't record or read", () => {
    const text = textOf(review(null, true));
    expect(text).toContain("its resolution couldn't be shown");
    expect(text).toContain("Review the whole diff, not only the resolution");
  });

  it("says when the resolution and the review packet are for different commits, in the loud view too", () => {
    const loud = withResolution({ status: "failed", reason: "GitHub failed" })({
      workItemId: "wi_13",
    });
    const away = {
      ...loud,
      babysitResolution: loud.babysitResolution && {
        ...loud.babysitResolution,
        sha: "0ddc0ffee12",
      },
    };
    expect(panel(away)).toContain('data-testid="resolution-other-head"');
  });

  it("says when the resolution and the review packet are for different commits", () => {
    const d = withResolution({ files: [file()] })({ workItemId: "wi_13" });
    const other = {
      ...d,
      babysitResolution: d.babysitResolution && { ...d.babysitResolution, sha: "0ddc0ffee12" },
    };
    const text = textOf(panel(other)).replace(/\s+/g, " ");
    expect(text).toMatch(/This resolution is for ?0ddc0ff ?, but the review packet is for/);
  });

  it("adds nothing to an ordinary merge gate, nor anywhere but a pending merge gate", () => {
    expect(review(null, false)).not.toContain('data-testid="resolution"');
    const d = withResolution({})({ workItemId: "wi_13" });
    const decided = { ...d, gates: d.gates.filter((g) => g.kind !== "merge") };
    expect(panel(decided)).not.toContain('data-testid="resolution"');
    expect(resolutionView(decided)).toEqual({ kind: "none" });
  });
});

describe("when merging needs the full diff opened first (review.merge's rule)", () => {
  const needs = (r: Partial<Resolution> | null, expected?: boolean) =>
    resolutionNeedsFullDiff(withResolution(r, expected)({ workItemId: "wi_13" }));
  it("only a clean resolution with nothing outside the conflict and nothing unlisted doesn't", () => {
    expect(needs({ files: [file()] })).toBe(false);
    expect(needs(null, false)).toBe(false);
    expect(needs({ files: [file()], outside: ["src/x.ts"] })).toBe(true);
    expect(needs({ files: [file()], outsideNotShown: 1 })).toBe(true);
    expect(needs({ files: [file()], notShown: 1 })).toBe(true);
    expect(needs({ status: "incomplete", reason: "too large" })).toBe(true);
    expect(needs(null, true)).toBe(true);
  });
});

describe("the Review tab's Merge, after a resolution", () => {
  const decision = (r: Partial<Resolution>, opened: boolean) => {
    const d = withResolution(r)({ workItemId: "wi_13" });
    const packet = d.reviewPacket ? parsePacket(d.reviewPacket) : null;
    if (!packet) throw new Error("fixture #13 has a packet");
    return render(<MergeDecision detail={d} packet={packet} opened={opened} />);
  };
  // Whether the Merge button has the disabled attribute (its classes mention `disabled:` too).
  const mergeButton = (html: string) =>
    /\sdisabled=""/.test(/<button[^>]*data-testid="merge"[^>]*>/.exec(html)?.[0] ?? "")
      ? "disabled"
      : "enabled";

  it("stays disabled until the full diff is opened, when there's more than the conflict to look at", () => {
    const closed = decision({ files: [file()], outside: ["src/x.ts"] }, false);
    expect(mergeButton(closed)).toContain("disabled");
    expect(closed).toContain('data-testid="merge-needs-diff"');
    expect(mergeButton(decision({ files: [file()], outside: ["src/x.ts"] }, true))).not.toContain(
      "disabled",
    );
    expect(mergeButton(decision({ files: [file()] }, false))).not.toContain("disabled");
  });
});

// The same table the engine's rule runs against (packages/core/test/resolution-gate.test.ts): the
// desktop's Merge and Inbox card can't drift from review.merge.
describe("the desktop's rule is the engine's", () => {
  for (const c of RESOLUTION_RULE_CASES) {
    it(c.name, () => {
      const d = withResolution(null, c.at.expected)({ workItemId: "wi_13" });
      const r = c.at.resolution;
      const detail: Detail = {
        ...d,
        resolvedHead: c.at.resolvedHead ?? null,
        babysitResolution: r && {
          sha: d.item.headSha ?? "9c41e07d2b",
          itemHead: null,
          main: null,
          patchBase: "itemHead",
          ...r,
          outside: [...r.outside],
          outsideNotShown: r.outsideNotShown ?? 0,
          files: r.files.map((f, i) => file({ path: `src/f${i}.ts`, ...f })),
        },
      };
      expect(resolutionNeedsFullDiff(detail)).toBe(c.needs);
    });
  }
});

describe("a resolution's patch, for exactly the head shown", () => {
  const show = (f: File, data: Parameters<typeof Patch>[0]["data"], isError = false) =>
    textOf(render(<Patch file={f} headSha="abc1234" data={data} isError={isError} />));
  const stored = (patches: Record<string, string>, headSha = "abc1234") => ({ headSha, patches });

  it("shows the patch, and says when it was clipped", () => {
    expect(show(file(), stored({ "src/verify.ts": "@@ -1 +1 @@\n-a\n+b" }))).toContain("+b");
    expect(
      show(file({ patchTruncated: true }), stored({ "src/verify.ts": "@@ -1 +1 @@" })),
    ).toContain("Clipped");
  });

  it("says what is true when there is none: omitted, loading, failed, another head, not stored, empty", () => {
    expect(show(file({ patchOmitted: true }), undefined)).toContain("gives no patch");
    expect(show(file(), undefined)).toContain("Loading the patch");
    expect(show(file(), undefined, true)).toContain("couldn't be loaded");
    expect(show(file(), stored({ "src/verify.ts": "+x" }, "fff0000"))).toContain(
      "The branch has moved on since this resolution",
    );
    expect(show(file(), stored({}))).toContain("No patch was stored for this file");
    expect(show(file(), stored({ "src/verify.ts": "" }))).toContain("No text changed");
  });
});

describe("the Inbox merge card after a resolution", () => {
  const inbox = (r: Partial<Resolution> | null, expected?: boolean) =>
    renderPage("/?item=wi_13", {
      answers: {
        "workItem.get": (i: unknown) => withResolution(r, expected)(i as { workItemId: string }),
      },
    });

  it("doesn't offer Merge when the resolution isn't clean: decide from the item's review", async () => {
    const html = await inbox({ status: "incomplete", reason: "too large to read in full" });
    expect(html).toContain('data-testid="inbox-resolution-whole"');
    expect(html).toContain('data-testid="inbox-merge-elsewhere"');
    expect(textOf(html)).toContain("The verdict below is about the checks only");
  });

  it("doesn't offer Merge when a resolution was expected but can't be shown", async () => {
    const html = await inbox(null, true);
    expect(html).toContain('data-testid="inbox-merge-elsewhere"');
  });

  it("shows a clean resolution's summary and lets the card merge when there is nothing else to look at", async () => {
    const html = await inbox({ files: [file()] });
    expect(html).toContain('data-testid="inbox-resolution-clean"');
    expect(html).not.toContain('data-testid="inbox-merge-elsewhere"');
    expect(html).toContain('data-testid="merge"');
  });

  it("doesn't offer Merge for a clean resolution with files outside the conflict, or unlisted ones", async () => {
    const outside = await inbox({ files: [file()], outside: ["src/x.ts"] });
    expect(outside).toContain('data-testid="inbox-merge-elsewhere"');
    expect(outside).not.toContain('data-testid="merge"');
    const said = textOf(outside).replace(/\s+/g, " ");
    expect(said).toMatch(/1 file outside the conflict differs from a plain merge ?: ?src\/x\.ts/);
    const unlisted = await inbox({ files: [file()], notShown: 2 });
    expect(unlisted).toContain('data-testid="inbox-merge-elsewhere"');
  });
});

// The babysitter's resolution at the reopened merge gate (spec 53, decision 1; #201 review): only
// the resolution when it was read in full; loud, with the full diff, when it wasn't or couldn't be
// shown at all; nothing extra on an ordinary gate. Patches only for the head shown. In the Inbox, a
// resolution that isn't clean can't be merged from the card.
import type { OpOutput } from "@software-factory/client/ops";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ANSWERS } from "../screenshots/fixtures.ts";
import { Patch, ResolutionPanel, resolutionView } from "../src/mainview/components/resolution.tsx";
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

  it("shows a clean resolution's summary and still lets the card merge", async () => {
    const html = await inbox({ files: [file()], outside: ["src/x.ts"] });
    expect(html).toContain('data-testid="inbox-resolution-clean"');
    expect(html).not.toContain('data-testid="inbox-merge-elsewhere"');
    expect(textOf(html)).toContain("1 file outside the conflict differs from a plain merge");
  });
});

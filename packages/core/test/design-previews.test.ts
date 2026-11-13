// Spec 22 part B: a design's revision is saved with the preview the runner's checks drew, only
// when it was drawn from exactly that content and holds nothing that could run or reach outside;
// a pulled file's base gets its own; the app reads it with the revision; and the approved plan
// writes each kept design's preview beside it as `.svg`, in the same commit (criterion 4).
import {
  type CapabilityManifest,
  CONTRACT_VERSION,
  type Job,
} from "@software-factory/runner-contract";
import { describe, expect, it } from "vitest";
import { FOREMAN } from "../src/index.ts";
import {
  call,
  first,
  newItem,
  ok,
  RUNNER_ACTOR,
  refusal,
  rows,
  services,
  uid,
  world,
} from "./helpers.ts";

const manifest: CapabilityManifest = {
  contractVersion: CONTRACT_VERSION,
  runnerKind: "orca",
  harnesses: ["claude-code"],
  capabilities: ["hooks"],
};
type W = Awaited<ReturnType<typeof world>>;
const D2 = "app -> db: reads\napp -> queue: jobs\n";
const SPEC = {
  specMd: "# Export\n\n## Scope\n- Members see Export",
  acceptanceCriteria: ["Members see Export"],
};

async function planning(w: W) {
  const r = await ok<{ runnerId: string }>("runner.register", { name: "M5" }, w.human);
  const m5 = RUNNER_ACTOR(r.runnerId);
  const item = await newItem(w, "Add CSV export");
  await ok("branch.ensure", { workItemId: item.workItemId }, FOREMAN);
  await ok("planning.start", { workItemId: item.workItemId }, FOREMAN);
  const { job } = await ok<{ job: Job | null }>(
    "job.claim",
    {
      claimId: uid("claim-"),
      manifest,
      capacity: { max: 2, inUse: 0, accepting: true, light: { max: 6, inUse: 0 } },
    },
    m5,
  );
  if (!job) throw new Error("expected the planning job");
  const agent = <O = Record<string, unknown>>(op: string, input: Record<string, unknown> = {}) =>
    ok<O>(op, { ...input, jobId: job.jobId, fencingToken: job.lease.fencingToken }, m5);
  return { item, agent };
}

/** Puts a file on the default branch, as a merge would. */
const onMain = (w: W, path: string, content: string) =>
  services.github.commitFile(w.repo, { branch: "main", path, content, message: "seed" });

const hex = async (text: string) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

/** A preview as the runner's checks would hand it over (drawn by hand here). */
const previewOf = async (
  content: string,
  svg = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>',
) => ({
  svg,
  width: 10,
  height: 10,
  parts: [{ id: "box app", kind: "box", label: "app", sig: "1", box: { x: 0, y: 0, w: 5, h: 5 } }],
  warnings: [],
  sha256: await hex(content),
});

describe("design previews (spec 22 part B)", () => {
  it("saves a design with its preview, and refuses one drawn from other content or unsafe", async () => {
    const w = await world();
    const { item, agent } = await planning(w);
    const add = { kind: "design", designType: "architecture", title: "Arch", content: D2 };
    const stale = await refusal(
      agent("artifact.add", { ...add, preview: await previewOf("other") }),
    );
    expect(stale.message).toMatch(/wasn't drawn from this content/);
    const unsafe = await refusal(
      agent("artifact.add", {
        ...add,
        preview: await previewOf(D2, "<svg><script>alert(1)</script></svg>"),
      }),
    );
    expect(unsafe.code).toBe("invalid_input");
    const mockup = await refusal(
      agent("artifact.add", { title: "M", content: D2, preview: await previewOf(D2) }),
    );
    expect(mockup.message).toMatch(/only a design has a preview/);
    const { artifactId } = await agent<{ artifactId: string }>("artifact.add", {
      ...add,
      preview: await previewOf(D2),
    });
    const got = await ok<{ designType: string; preview: { parts: { id: string }[] } | null }>(
      "artifact.get",
      { workItemId: item.workItemId, artifactId },
      w.human,
    );
    expect(got.designType).toBe("architecture");
    expect(got.preview?.parts[0]?.id).toBe("box app");
    // A revision without a preview (an older runner) is saved, and has none.
    await agent("artifact.update", { artifactId, content: `${D2}x -> y\n` });
    const later = await ok<{ preview: unknown }>(
      "artifact.get",
      { workItemId: item.workItemId, artifactId },
      w.human,
    );
    expect(later.preview).toBeNull();
    const size = await first<{ size: number }>(
      "SELECT size FROM core_planning_artifact_revisions WHERE artifact_id = ? AND revision = 1",
      artifactId,
    );
    expect(size.size).toBeGreaterThan(D2.length);
  });

  it("never overwrites a hand-made .svg with a drawing, and clears a base's drawing on a re-pull (review of #163)", async () => {
    const w = await world();
    await onMain(w, ".kim/designs/system.d2", D2);
    await onMain(w, ".kim/designs/system.d2.svg", "<svg>drawn by hand</svg>");
    const { item, agent } = await planning(w);
    const pulled = await agent<{ artifactId: string }>("design.pull", {
      path: ".kim/designs/system.d2",
    });
    await agent("design.preview", {
      artifactId: pulled.artifactId,
      revision: 0,
      preview: await previewOf(D2),
    });
    // The default branch moves on and the planner pulls again: the old base's drawing goes.
    const next = `${D2}app -> cache: reads\n`;
    await onMain(w, ".kim/designs/system.d2", next);
    await agent("design.pull", { path: ".kim/designs/system.d2" });
    const base = await ok<{ preview: unknown; content: string }>(
      "artifact.get",
      { workItemId: item.workItemId, artifactId: pulled.artifactId, revision: 0 },
      w.human,
    );
    expect(base.content).toBe(next);
    expect(base.preview).toBeNull();
    // The planner's revision, drawn, is approved; the hand-made drawing on the branch stays.
    const mine = `${next}app -> search: queries\n`;
    await agent("artifact.update", {
      artifactId: pulled.artifactId,
      content: mine,
      preview: await previewOf(mine),
    });
    const { specId } = await agent<{ specId: string }>("spec.revise", SPEC);
    await agent("planning.news");
    await agent("planning.ready");
    await call("spec.accept", { workItemId: item.workItemId, specId }, FOREMAN);
    await ok("spec.approve", { workItemId: item.workItemId }, w.human);
    await rows("UPDATE core_specs SET status = 'approved' WHERE id = ?", specId);
    await ok("spec.commit", { workItemId: item.workItemId }, FOREMAN);
    const branch = (
      await first<{ branch: string }>(
        "SELECT branch FROM core_work_items WHERE id = ?",
        item.workItemId,
      )
    ).branch;
    const read = (path: string) => services.github.readFile(w.repo, path, branch);
    expect(await read(".kim/designs/system.d2")).toBe(mine);
    // Not written over (the fake's branch doesn't carry main's copy; main's stays as it was).
    expect((await read(".kim/designs/system.d2.svg")) ?? "").not.toContain("<rect");
    expect(await services.github.readFile(w.repo, ".kim/designs/system.d2.svg", "main")).toBe(
      "<svg>drawn by hand</svg>",
    );
  });

  it("stores a pulled base's preview, and reads revision 0 back (criterion 3)", async () => {
    const w = await world();
    await onMain(w, ".kim/designs/system.d2", D2);
    const { item, agent } = await planning(w);
    const pulled = await agent<{ artifactId: string }>("design.pull", {
      path: ".kim/designs/system.d2",
    });
    const read = await agent<{ designType: string; content: string }>("artifact.read", {
      artifactId: pulled.artifactId,
      revision: 0,
    });
    expect(read).toMatchObject({ designType: "architecture", content: D2 });
    const wrong = await refusal(
      agent("design.preview", {
        artifactId: pulled.artifactId,
        revision: 0,
        preview: await previewOf("not the base"),
      }),
    );
    expect(wrong.code).toBe("invalid_input");
    for (const revision of [0, 1]) {
      await agent("design.preview", {
        artifactId: pulled.artifactId,
        revision,
        preview: await previewOf(D2),
      });
    }
    const base = await ok<{ revision: number; preview: unknown }>(
      "artifact.get",
      { workItemId: item.workItemId, artifactId: pulled.artifactId, revision: 0 },
      w.human,
    );
    expect(base.revision).toBe(0);
    expect(base.preview).not.toBeNull();
  });

  it("writes each kept design's preview beside it as .svg, in the spec's commit (criterion 4)", async () => {
    const w = await world();
    const { item, agent } = await planning(w);
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20"/></svg>';
    await agent("artifact.add", {
      kind: "design",
      designType: "architecture",
      title: "System",
      content: D2,
      keep: true,
      preview: await previewOf(D2, svg),
    });
    // A dropped design's preview isn't written.
    await agent("artifact.add", {
      kind: "design",
      designType: "data-model",
      title: "Draft schema",
      content: "Table a {\n id int\n}\n",
      preview: await previewOf("Table a {\n id int\n}\n"),
    });
    const { specId } = await agent<{ specId: string }>("spec.revise", SPEC);
    await agent("planning.news");
    await agent("planning.ready");
    const listed = await ok<{ files: { path: string; kind: string }[]; kimCount: number }>(
      "spec.writeBack",
      { workItemId: item.workItemId },
      w.human,
    );
    expect(listed.files.map((f) => [f.path, f.kind])).toContainEqual([
      ".kim/designs/system.d2.svg",
      "preview",
    ]);
    expect(listed.files.some((f) => f.path.includes("draft-schema"))).toBe(false);
    const gate = await call("spec.accept", { workItemId: item.workItemId, specId }, FOREMAN);
    expect(gate.status).toBe("pending");
    await ok("spec.approve", { workItemId: item.workItemId }, w.human);
    await rows("UPDATE core_specs SET status = 'approved' WHERE id = ?", specId);
    await ok("spec.commit", { workItemId: item.workItemId }, FOREMAN);
    const branch = (
      await first<{ branch: string }>(
        "SELECT branch FROM core_work_items WHERE id = ?",
        item.workItemId,
      )
    ).branch;
    expect(await services.github.readFile(w.repo, ".kim/designs/system.d2.svg", branch)).toBe(svg);
    expect(await services.github.readFile(w.repo, ".kim/designs/system.d2", branch)).toBe(D2);
  });
});

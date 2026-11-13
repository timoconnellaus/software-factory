// Spec 22 part A: system designs and the repository's `.kim/` folder. A design names its type; a
// file is pulled from the default branch with its content there kept as the base; the approved
// plan, its kept mockups and designs land in .kim/ in the same commit as the spec; and a pulled
// file that changed on the default branch blocks the gate until the planner merges it.
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

/** Opens the gate and a person approves it; the Workflow's re-run of spec.accept, as SQL. */
async function approve(
  w: W,
  workItemId: string,
  specId: string,
  agent: (op: string, input?: Record<string, unknown>) => Promise<unknown>,
) {
  await agent("planning.news");
  await agent("planning.ready");
  const gate = await call("spec.accept", { workItemId, specId }, FOREMAN);
  expect(gate.status).toBe("pending");
  await ok("spec.approve", { workItemId }, w.human);
  await rows("UPDATE core_specs SET status = 'approved' WHERE id = ?", specId);
}

/** Puts a file on the default branch, as a merge would. */
const onMain = (w: W, path: string, content: string) =>
  services.github.commitFile(w.repo, { branch: "main", path, content, message: "seed" });

describe("system designs and .kim/ (spec 22)", () => {
  it("names a design's type, and refuses one without", async () => {
    const w = await world();
    const { agent } = await planning(w);
    const missing = await refusal(
      agent("artifact.add", { kind: "design", title: "Arch", content: D2 }),
    );
    expect(missing.code).toBe("invalid_input");
    expect(
      await agent<{ artifactId: string }>("artifact.add", {
        kind: "design",
        designType: "architecture",
        title: "Arch",
        content: D2,
      }),
    ).toMatchObject({ revision: 1 });
  });

  it("pulls a .kim/ file with its base, and the approved plan writes the kept ones back in one commit (criteria 3, 4)", async () => {
    const w = await world();
    await onMain(w, ".kim/designs/system.d2", D2);
    const { item, agent } = await planning(w);
    const pulled = await agent<{ artifactId: string }>("design.pull", {
      path: ".kim/designs/system.d2",
    });
    await agent("artifact.update", {
      artifactId: pulled.artifactId,
      content: `${D2}app -> cache: reads\n`,
    });
    const view = await ok<{
      artifacts: { id: string; designType: string; pulledPath: string; keep: boolean }[];
    }>("planning.get", { workItemId: item.workItemId }, w.human);
    expect(view.artifacts).toContainEqual(
      expect.objectContaining({
        designType: "architecture",
        pulledPath: ".kim/designs/system.d2",
        keep: true,
      }),
    );
    const base = await first<{ content: string }>(
      "SELECT content FROM core_planning_artifact_revisions WHERE artifact_id = ? AND revision = 0",
      pulled.artifactId,
    );
    expect(base.content).toBe(D2);
    // A kept mockup lands; a draft (not kept) one doesn't.
    await agent("artifact.add", { title: "Export button", content: "<p>Export</p>", keep: true });
    await agent("artifact.add", { title: "Scratch", content: "<p>scratch</p>" });
    const { specId } = await agent<{ specId: string }>("spec.revise", SPEC);
    await approve(w, item.workItemId, specId, agent);
    const committed = await ok<{ commitSha: string }>(
      "spec.commit",
      { workItemId: item.workItemId },
      FOREMAN,
    );
    const branch = (
      await first<{ branch: string }>(
        "SELECT branch FROM core_work_items WHERE id = ?",
        item.workItemId,
      )
    ).branch;
    const read = (path: string) => services.github.readFile(w.repo, path, branch);
    expect(await read(".kim/designs/system.d2")).toContain("app -> cache");
    expect(await read(".kim/mockups/export-button.html")).toBe("<p>Export</p>");
    expect(await read(".kim/mockups/scratch.html")).toBeNull();
    expect(
      await read(`.kim/plans/wi-${item.number}-${item.branch.split("-").slice(1).join("-")}.md`),
    ).not.toBeUndefined();
    const changed = await services.github.compareFiles(w.repo, "main", branch);
    expect(changed.map((c) => c.path)).toEqual(
      expect.arrayContaining([".kim/designs/system.d2", ".kim/mockups/export-button.html"]),
    );
    expect(committed.commitSha).toBeTruthy();
  });

  it("blocks the gate while a pulled file changed on the default branch, until the planner merges it (criterion 5)", async () => {
    const w = await world();
    await onMain(w, ".kim/designs/system.d2", D2);
    const { agent } = await planning(w);
    const pulled = await agent<{ artifactId: string }>("design.pull", {
      path: ".kim/designs/system.d2",
    });
    await agent("spec.revise", SPEC);
    await agent("planning.news");
    // Someone changed it on the default branch meanwhile.
    await onMain(w, ".kim/designs/system.d2", `${D2}app -> search: queries\n`);
    const refused = await refusal(agent("planning.ready"));
    expect(refused.code).toBe("conflict");
    expect(refused.message).toContain(".kim/designs/system.d2");
    // The planner pulls again (the new base) and merges.
    await agent("design.pull", { path: ".kim/designs/system.d2" });
    await agent("artifact.update", {
      artifactId: pulled.artifactId,
      content: `${D2}app -> search: queries\napp -> cache: reads\n`,
    });
    expect(await agent("planning.ready")).toMatchObject({ round: 1 });
  });

  it("refuses to approve while a pulled file changed on the default branch after the gate opened (criterion 5)", async () => {
    const w = await world();
    await onMain(w, ".kim/designs/system.d2", D2);
    const { item, agent } = await planning(w);
    await agent("design.pull", { path: ".kim/designs/system.d2" });
    const { specId } = await agent<{ specId: string }>("spec.revise", SPEC);
    await agent("planning.news");
    await agent("planning.ready");
    const gate = await call("spec.accept", { workItemId: item.workItemId, specId }, FOREMAN);
    expect(gate.status).toBe("pending");
    await onMain(w, ".kim/designs/system.d2", `${D2}app -> search: queries\n`);
    const refused = await refusal(ok("spec.approve", { workItemId: item.workItemId }, w.human));
    expect(refused.code).toBe("conflict");
    expect(refused.message).toContain("request changes so the planner merges it");
  });

  it("refuses changing artifacts while the plan waits at the gate (review of #130)", async () => {
    const w = await world();
    await onMain(w, ".kim/designs/system.d2", D2);
    const { item, agent } = await planning(w);
    const m = await agent<{ artifactId: string }>("artifact.add", {
      title: "Export button",
      content: "<p>Export</p>",
      keep: true,
    });
    const { specId } = await agent<{ specId: string }>("spec.revise", SPEC);
    await agent("planning.news");
    await agent("planning.ready");
    expect(
      (await call("spec.accept", { workItemId: item.workItemId, specId }, FOREMAN)).status,
    ).toBe("pending");
    for (const [op, input] of [
      ["artifact.update", { artifactId: m.artifactId, content: "<p>Changed</p>" }],
      ["artifact.add", { title: "Late", content: "<p>late</p>", keep: true }],
      ["artifact.delete", { artifactId: m.artifactId }],
      ["design.pull", { path: ".kim/designs/system.d2" }],
    ] as const) {
      const refused = await refusal(agent(op, input));
      expect(refused.code, op).toBe("conflict");
      expect(refused.message, op).toContain("waiting at the gate");
    }
    const kept = await first<{ revision: number }>(
      "SELECT revision FROM core_planning_artifacts WHERE id = ?",
      m.artifactId,
    );
    expect(kept.revision).toBe(1);
  });

  it("lists every file the write-back writes at the gate, and commits exactly the approved revisions (review of #130)", async () => {
    const w = await world();
    await onMain(w, ".kim/designs/system.d2", D2);
    await onMain(w, ".kim/designs/same.d2", D2);
    const { item, agent } = await planning(w);
    const pulled = await agent<{ artifactId: string }>("design.pull", {
      path: ".kim/designs/system.d2",
    });
    await agent("artifact.update", {
      artifactId: pulled.artifactId,
      content: `${D2}app -> cache: reads\n`,
    });
    // Pulled and unchanged: nothing to write, so not listed and not committed.
    await agent("design.pull", { path: ".kim/designs/same.d2" });
    const m = await agent<{ artifactId: string }>("artifact.add", {
      title: "Export button",
      content: "<p>Export</p>",
      keep: true,
    });
    // Same title: a second path, not an overwrite.
    await agent("artifact.add", { title: "Export button", content: "<p>Two</p>", keep: true });
    const { specId } = await agent<{ specId: string }>("spec.revise", SPEC);
    const listed = await ok<{
      files: { path: string; status: string; content: string; base: string | null }[];
      kimCount: number;
    }>("spec.writeBack", { workItemId: item.workItemId }, w.human);
    const plan = `.kim/plans/wi-${item.number}-${item.branch.split("-").slice(1).join("-")}.md`;
    expect(listed.files.map((f) => [f.path, f.status])).toEqual([
      [expect.stringMatching(/^docs\/specs\//), "new"],
      [expect.stringMatching(/^\.kim\/plans\//), "new"],
      [".kim/designs/system.d2", "changed"],
      [".kim/mockups/export-button.html", "new"],
      [".kim/mockups/export-button-2.html", "new"],
    ]);
    expect(listed.files[2]?.base).toBe(D2);
    expect(listed.kimCount).toBe(4);
    await approve(w, item.workItemId, specId, agent);
    // By any route, a newer revision appears after approval: the approved one is still what lands.
    await rows(
      "INSERT INTO core_planning_artifact_revisions (artifact_id, revision, content, size, controls, created_at) VALUES (?, 2, '<p>Sneaked</p>', 14, '[]', '2026-11-13T00:00:00Z')",
      m.artifactId,
    );
    await rows("UPDATE core_planning_artifacts SET revision = 2 WHERE id = ?", m.artifactId);
    await ok("spec.commit", { workItemId: item.workItemId }, FOREMAN);
    const branch = (
      await first<{ branch: string }>(
        "SELECT branch FROM core_work_items WHERE id = ?",
        item.workItemId,
      )
    ).branch;
    const read = (path: string) => services.github.readFile(w.repo, path, branch);
    expect(await read(".kim/mockups/export-button.html")).toBe("<p>Export</p>");
    expect(await read(".kim/mockups/export-button-2.html")).toBe("<p>Two</p>");
    expect(await read(".kim/designs/system.d2")).toContain("app -> cache");
    expect(await read(plan)).toContain("Members see Export");
    const changed = await services.github.compareFiles(w.repo, "main", branch);
    expect(
      changed
        .map((c) => c.path)
        .filter((p) => p.startsWith(".kim/"))
        .sort(),
    ).toEqual(
      [
        plan,
        ".kim/designs/system.d2",
        ".kim/mockups/export-button-2.html",
        ".kim/mockups/export-button.html",
      ].sort(),
    );
  });

  it("refuses to commit when an approved revision is gone or its content differs (review of #130)", async () => {
    const w = await world();
    const { item, agent } = await planning(w);
    const m = await agent<{ artifactId: string }>("artifact.add", {
      title: "Export button",
      content: "<p>Export</p>",
      keep: true,
    });
    const { specId } = await agent<{ specId: string }>("spec.revise", SPEC);
    await approve(w, item.workItemId, specId, agent);
    await rows(
      "UPDATE core_planning_artifact_revisions SET content = '<p>Tampered</p>' WHERE artifact_id = ? AND revision = 1",
      m.artifactId,
    );
    const refused = await refusal(ok("spec.commit", { workItemId: item.workItemId }, FOREMAN));
    expect(refused.code).toBe("conflict");
    expect(refused.message).toContain(".kim/mockups/export-button.html");
    await rows("DELETE FROM core_planning_artifact_revisions WHERE artifact_id = ?", m.artifactId);
    expect((await refusal(ok("spec.commit", { workItemId: item.workItemId }, FOREMAN))).code).toBe(
      "conflict",
    );
  });

  it("refuses pulled paths the tree API or the folder wouldn't take (review of #130)", async () => {
    const w = await world();
    const { agent } = await planning(w);
    for (const path of [
      ".kim/designs/./x.d2",
      ".kim/designs//x.d2",
      `.kim/designs/${"a".repeat(200)}.d2`,
      ".kim/designs/x.txt",
      ".kim/designs/x.mermaid",
      ".kim/mockups/x.md",
      ".kim/mockups/x.svg",
      ".kim/plans/x.html",
    ]) {
      expect((await refusal(agent("design.pull", { path }))).code, path).toBe("invalid_input");
    }
  });
});

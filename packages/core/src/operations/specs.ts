// The living spec (CONTEXT.md): drafted by the spec stage's run, gated by `spec.accept` (risk
// `plan`, always reviewed for agents), committed to the work item's branch on approval.
import { parseJson } from "@software-factory/db";
import { specResultSchema } from "@software-factory/runner-contract";
import { z } from "zod";
import { newId } from "../ids.ts";
import { OperationError } from "../errors.ts";
import { defineOperation } from "../operation.ts";
import { repoRef, requireProject, requireWorkItem, workItemId } from "./shared.ts";

export const specPropose = defineOperation({
  name: "spec.propose",
  description:
    "Store a new version of a work item's living spec (stage-spec format: Goal / Scope / Out of scope / Acceptance criteria) with its acceptance criteria and assumptions, from the spec stage's run. Questions it raised are asked separately (question.ask).",
  risk: "write",
  actors: ["agent"],
  permission: "signed-in",
  input: z.object({ workItemId, spec: specResultSchema.omit({ questions: true }) }),
  output: z.object({ specId: z.string(), version: z.number() }),
  async handler(input, ctx) {
    const w = requireWorkItem(ctx);
    const latest = await ctx.db
      .selectFrom("core_specs")
      .select((eb) => eb.fn.max("version").as("v"))
      .where("work_item_id", "=", w.id)
      .executeTakeFirst();
    const version = (latest?.v ?? 0) + 1;
    const specId = newId("spec");
    ctx.write(
      ctx.db
        .updateTable("core_specs")
        .set({ status: "superseded" })
        .where("work_item_id", "=", w.id)
        .where("status", "=", "draft"),
    );
    ctx.write(
      ctx.db.insertInto("core_specs").values({
        id: specId,
        work_item_id: w.id,
        version,
        body_md: input.spec.specMd,
        acceptance_criteria: JSON.stringify(input.spec.acceptanceCriteria),
        assumptions: JSON.stringify(input.spec.assumptions),
        status: "draft",
        created_by: ctx.actor.id,
        created_at: ctx.now,
      }),
    );
    ctx.write(
      ctx.db.updateTable("core_work_items").set({ current_spec_id: specId, updated_at: ctx.now }).where("id", "=", w.id),
    );
    ctx.change({ entity: "spec", id: specId, after: { version, criteria: input.spec.acceptanceCriteria.length } });
    return { specId, version };
  },
});

export const specAccept = defineOperation({
  name: "spec.accept",
  description:
    "Accept the work item's current spec so the build can start. Risk `plan`: the gate check sends it to review for agents under every autonomy policy, so this is the spec gate; a person decides it with spec.approve or spec.requestChanges.",
  risk: "plan",
  actors: ["agent", "human"],
  permission: "approver",
  gateKind: "spec",
  input: z.object({ workItemId, specId: z.string().min(1) }),
  output: z.object({ specId: z.string(), approvedBy: z.string() }),
  async handler(input, ctx) {
    const w = requireWorkItem(ctx);
    if (w.current_spec_id !== input.specId) {
      throw new OperationError("conflict", "the spec changed since this gate opened");
    }
    const approvedBy = ctx.approval?.decided_by ?? ctx.actor.id;
    ctx.write(
      ctx.db
        .updateTable("core_specs")
        .set({ status: "approved", approved_at: ctx.now, approved_by: approvedBy })
        .where("id", "=", input.specId)
        .where("status", "=", "draft"),
    );
    ctx.guardChanged("spec still a draft");
    ctx.change({ entity: "spec", id: input.specId, before: { status: "draft" }, after: { status: "approved", approvedBy } });
    return { specId: input.specId, approvedBy };
  },
});

export const specCommit = defineOperation({
  name: "spec.commit",
  description:
    "Commit the approved spec to docs/specs/ on the work item's branch (never main) through the GitHub App, so the build starts from it.",
  risk: "write",
  actors: ["agent"],
  permission: "signed-in",
  input: z.object({ workItemId }),
  output: z.object({ path: z.string(), commitSha: z.string() }),
  async handler(_input, ctx) {
    const w = requireWorkItem(ctx);
    const spec = w.current_spec_id
      ? await ctx.db.selectFrom("core_specs").selectAll().where("id", "=", w.current_spec_id).executeTakeFirst()
      : undefined;
    if (!spec || spec.status !== "approved") throw new OperationError("conflict", "no approved spec");
    if (spec.commit_sha && spec.path) return { path: spec.path, commitSha: spec.commit_sha };
    const path = `docs/specs/wi-${w.number}-${w.slug}.md`;
    const criteria = parseJson<string[]>(spec.acceptance_criteria, []);
    const content = spec.body_md.includes("Acceptance criteria")
      ? spec.body_md
      : `${spec.body_md}\n\n## Acceptance criteria\n${criteria.map((c, i) => `${i + 1}. ${c}`).join("\n")}\n`;
    const repo = await repoRef(ctx, requireProject(ctx));
    const { commitSha } = await ctx.services.github.commitFile(repo, {
      branch: w.branch,
      path,
      content,
      message: `spec: ${w.title} (work item ${w.number})`,
    });
    ctx.write(ctx.db.updateTable("core_specs").set({ path, commit_sha: commitSha }).where("id", "=", spec.id));
    ctx.write(ctx.db.updateTable("core_work_items").set({ head_sha: commitSha, updated_at: ctx.now }).where("id", "=", w.id));
    ctx.change({ entity: "spec", id: spec.id, after: { path, commitSha } });
    return { path, commitSha };
  },
});

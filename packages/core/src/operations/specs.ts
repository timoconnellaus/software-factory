// The living spec (CONTEXT.md): drafted by the spec stage's run, gated by `spec.accept` (risk
// `plan`, always reviewed for agents), committed to the work item's branch on approval.
import { parseJson } from "@software-factory/db";
import { droppedEdits, specResultSchema } from "@software-factory/runner-contract";
import { z } from "zod";
import { OperationError } from "../errors.ts";
import { newId } from "../ids.ts";
import { keptArtifacts, kimPath } from "../kim.ts";
import { defineOperation } from "../operation.ts";
import { guardCurrentSpec, openSession, standingEdits } from "../planning.ts";
import { repoRef, requireRepository, requireWorkItem, workItemId } from "./shared.ts";

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
    // While a planning session holds the plan, only it writes the plan (spec.revise), and a
    // person's standing edits stay word for word (review of #85, round 2).
    if (await openSession(ctx, w.id)) {
      throw new OperationError(
        "conflict",
        "a planning session is writing this plan: it revises it with spec.revise",
      );
    }
    const dropped = droppedEdits(input.spec.specMd, await standingEdits(ctx, w.id));
    if (dropped.length) {
      throw new OperationError(
        "conflict",
        "this spec doesn't keep a person's edits to the plan word for word",
        { editIds: dropped.map((e) => e.id) },
      );
    }
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
    guardCurrentSpec(ctx, w, "the plan is still the version this spec was written on");
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
    // Guarded: the plan is still the version this was written on.
    ctx.write(
      ctx.db
        .updateTable("core_work_items")
        .set({ current_spec_id: specId, updated_at: ctx.now })
        .where("id", "=", w.id)
        .where((eb) =>
          w.current_spec_id === null
            ? eb("current_spec_id", "is", null)
            : eb("current_spec_id", "=", w.current_spec_id),
        ),
    );
    ctx.guardChanged("the plan is still the version this spec was written on");
    ctx.change({
      entity: "spec",
      id: specId,
      after: { version, criteria: input.spec.acceptanceCriteria.length },
    });
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
    ctx.change({
      entity: "spec",
      id: input.specId,
      before: { status: "draft" },
      after: { status: "approved", approvedBy },
    });
    return { specId: input.specId, approvedBy };
  },
});

export const specCommit = defineOperation({
  name: "spec.commit",
  description:
    "Commit the approved spec to docs/specs/ on the work item's branch (never main) through the GitHub App, so the build starts from it. In the same commit, the plan and every kept planning artifact land in the repo's .kim/ folder (spec 22): the plan in .kim/plans/, mockups in .kim/mockups/, designs in .kim/designs/ (a pulled file back at its path). Dropped and draft artifacts aren't committed.",
  risk: "write",
  actors: ["agent"],
  permission: "signed-in",
  input: z.object({ workItemId }),
  output: z.object({ path: z.string(), commitSha: z.string() }),
  async handler(_input, ctx) {
    const w = requireWorkItem(ctx);
    const spec = w.current_spec_id
      ? await ctx.db
          .selectFrom("core_specs")
          .selectAll()
          .where("id", "=", w.current_spec_id)
          .executeTakeFirst()
      : undefined;
    if (spec?.status !== "approved") throw new OperationError("conflict", "no approved spec");
    if (spec.commit_sha && spec.path) return { path: spec.path, commitSha: spec.commit_sha };
    const path = `docs/specs/wi-${w.number}-${w.slug}.md`;
    const content = specDocument(spec);
    const repo = await repoRef(ctx, requireRepository(ctx));
    // Spec 22: the plan and the kept artifacts, in the same commit as the spec.
    const kept = await keptArtifacts(ctx, w.id);
    const files = [
      { path, content },
      { path: `.kim/plans/wi-${w.number}-${w.slug}.md`, content },
      ...kept.map((a) => ({ path: kimPath(a), content: a.content })),
    ];
    const unique = [...new Map(files.map((f) => [f.path, f])).values()];
    const { commitSha } = await ctx.services.github.commitFiles(repo, {
      branch: w.branch,
      files: unique,
      message: `spec: ${w.title} (work item ${w.number})${kept.length ? `, with ${kept.length} kept artifact${kept.length === 1 ? "" : "s"} in .kim/` : ""}`,
    });
    ctx.write(
      ctx.db
        .updateTable("core_specs")
        .set({ path, commit_sha: commitSha })
        .where("id", "=", spec.id),
    );
    ctx.write(
      ctx.db
        .updateTable("core_work_items")
        .set({ head_sha: commitSha, updated_at: ctx.now })
        .where("id", "=", w.id),
    );
    ctx.change({ entity: "spec", id: spec.id, after: { path, commitSha } });
    return { path, commitSha };
  },
});

const hasSection = (body: string, name: string) =>
  new RegExp(`^#{1,4}\\s*${name}\\b`, "im").test(body);

/**
 * The committed spec (ADR 0302): the living spec's body as written, with its provenance tags, plus
 * any of Acceptance criteria, Assumptions, Coverage and Clarifications it doesn't already have.
 */
export function specDocument(spec: {
  body_md: string;
  acceptance_criteria: string;
  assumptions: string;
  coverage?: string;
  clarifications?: string;
}): string {
  const criteria = parseJson<string[]>(spec.acceptance_criteria, []);
  const assumptions = parseJson<string[]>(spec.assumptions, []);
  const coverage = parseJson<
    { category: string; status: string; questions?: number[]; note?: string }[]
  >(spec.coverage ?? "[]", []);
  const clarifications = parseJson<{ question?: number; q: string; a: string; date: string }[]>(
    spec.clarifications ?? "[]",
    [],
  );
  const parts = [spec.body_md.trimEnd()];
  if (!hasSection(spec.body_md, "Acceptance criteria") && criteria.length) {
    parts.push(`## Acceptance criteria\n${criteria.map((c, i) => `${i + 1}. ${c}`).join("\n")}`);
  }
  if (!hasSection(spec.body_md, "Assumptions") && assumptions.length) {
    parts.push(
      `## Assumptions\nReversible; each can be overturned into a question.\n${assumptions
        .map((a) => `- ${a}${/\[assumption\]/.test(a) ? "" : " [assumption]"}`)
        .join("\n")}`,
    );
  }
  if (!hasSection(spec.body_md, "Coverage") && coverage.length) {
    parts.push(
      `## Coverage\n${coverage
        .map(
          (c) =>
            `- ${c.category}: ${c.status}${c.questions?.length ? ` (${c.questions.map((n) => `Q${n}`).join(", ")})` : ""}${c.note ? `, ${c.note}` : ""}`,
        )
        .join("\n")}`,
    );
  }
  if (!hasSection(spec.body_md, "Clarifications") && clarifications.length) {
    parts.push(
      `## Clarifications\n${clarifications
        .map((c) => `- ${c.date}${c.question ? ` [Q${c.question}]` : ""}: ${c.q} → ${c.a}`)
        .join("\n")}`,
    );
  }
  return `${parts.join("\n\n")}\n`;
}

// The Question object (ADR 0042): asked by the foreman during planning, answered by people. A
// blocking question pauses the Workflow like a gate; when the last blocking question of a planning
// round is answered, the Workflow gets `questions-<item>-<round>`.
import { questionDraftSchema } from "@software-factory/runner-contract";
import { z } from "zod";
import { OperationError } from "../errors.ts";
import { newId } from "../ids.ts";
import { defineOperation, type HandlerContext } from "../operation.ts";
import { approverIds, backupOwnerId } from "../scope.ts";
import { questionsEvent } from "../workflow-events.ts";
import { questionId, requireWorkItem, workItemId } from "./shared.ts";

/** Questions bulk accept never covers (ADR 0042). */
export const NEVER_BULK_ACCEPTED_DOMAINS = ["security", "privacy", "security-privacy"] as const;

export const questionAsk = defineOperation({
  name: "question.ask",
  description:
    "Ask the people on a work item questions, each with a default and a recommendation (ADR 0042). Prefer recording a reversible choice as an assumption on the spec instead. Questions go to the project approver in V1 (decision-domain owners in milestone (c)).",
  risk: "write",
  actors: ["agent"],
  permission: "signed-in",
  input: z.object({ workItemId, questions: z.array(questionDraftSchema).min(1).max(20) }),
  output: z.object({ questionIds: z.array(z.string()), round: z.number() }),
  async handler(input, ctx) {
    const w = requireWorkItem(ctx);
    const approvers = await approverIds(ctx.db, w.org_id, ctx.scope.policy);
    const assignee = approvers.includes(w.requester_user_id)
      ? w.requester_user_id
      : (approvers[0] ?? null);
    const hours = ctx.scope.policy?.timeouts.questionHours ?? 48;
    const timeoutAt = new Date(Date.parse(ctx.now) + hours * 3_600_000).toISOString();
    const ids: string[] = [];
    for (const q of input.questions) {
      const id = newId("question");
      ids.push(id);
      ctx.write(
        ctx.db.insertInto("core_questions").values({
          id,
          work_item_id: w.id,
          project_id: w.project_id,
          org_id: w.org_id,
          domain: q.domain,
          prompt: q.prompt,
          context: q.context ?? null,
          options: JSON.stringify(q.options),
          default_answer: q.defaultAnswer ?? null,
          recommendation: q.recommendation ?? null,
          recommendation_reason: q.recommendationReason ?? null,
          blocking: q.blocking ? 1 : 0,
          irreversible: q.irreversible ? 1 : 0,
          assignee_user_id: assignee,
          planning_round: w.planning_round,
          timeout_at: timeoutAt,
          asked_by: ctx.actor.id,
          created_at: ctx.now,
        }),
      );
    }
    if (assignee) {
      ctx.emit({
        kind: "notify",
        payload: {
          event: "question.asked",
          userId: assignee,
          workItemId: w.id,
          title: `${ids.length} question${ids.length === 1 ? "" : "s"} on ${w.title}`,
          url: `/?item=${w.id}`,
        },
      });
    }
    ctx.change({ entity: "work_item", id: w.id, after: { questionsAsked: ids.length } });
    return { questionIds: ids, round: w.planning_round };
  },
});

export const workItemAwaitQuestions = defineOperation({
  name: "workItem.awaitQuestions",
  description:
    "Start waiting for the open blocking questions: bumps the planning round, whose event (`questions-<item>-<round>`) fires when the last one is answered. Returns how many are still open; 0 means don't wait.",
  risk: "write",
  actors: ["agent"],
  permission: "signed-in",
  input: z.object({ workItemId }),
  output: z.object({ round: z.number(), open: z.number(), event: z.string() }),
  async handler(_input, ctx) {
    const w = requireWorkItem(ctx);
    const round = w.planning_round + 1;
    const open = await openBlocking(ctx, w.id);
    // Questions asked in the round being closed move to the new round, so their answers name it.
    ctx.write(
      ctx.db
        .updateTable("core_questions")
        .set({ planning_round: round })
        .where("work_item_id", "=", w.id)
        .where("status", "=", "open"),
    );
    ctx.write(
      ctx.db
        .updateTable("core_work_items")
        .set({
          planning_round: round,
          ...(open > 0 ? { status: "waiting" as const } : {}),
          updated_at: ctx.now,
        })
        .where("id", "=", w.id),
    );
    return { round, open, event: questionsEvent(w.id, round) };
  },
});

async function openBlocking(ctx: Pick<HandlerContext, "db">, id: string): Promise<number> {
  const row = await ctx.db
    .selectFrom("core_questions")
    .select((eb) => eb.fn.countAll().as("n"))
    .where("work_item_id", "=", id)
    .where("status", "=", "open")
    .where("blocking", "=", 1)
    .executeTakeFirst();
  return Number(row?.n ?? 0);
}

/** Queues the answer and, when it closes the round, the Workflow event. */
function answer(
  ctx: HandlerContext,
  q: { id: string; work_item_id: string },
  value: string,
  acceptedDefault: boolean,
) {
  ctx.write(
    ctx.db
      .updateTable("core_questions")
      .set({
        status: "answered",
        answer: value,
        accepted_default: acceptedDefault ? 1 : 0,
        answered_by: ctx.actor.id,
        answered_at: ctx.now,
      })
      .where("id", "=", q.id)
      .where("status", "=", "open"),
  );
  ctx.guardChanged(`answer ${q.id} once`);
  ctx.change({
    entity: "question",
    id: q.id,
    before: { status: "open" },
    after: { answer: value, acceptedDefault },
  });
}

async function closeRoundIfDone(ctx: HandlerContext, answeredIds: string[]) {
  const w = requireWorkItem(ctx);
  const stillOpen = await ctx.db
    .selectFrom("core_questions")
    .select("id")
    .where("work_item_id", "=", w.id)
    .where("status", "=", "open")
    .where("blocking", "=", 1)
    .execute();
  if (stillOpen.some((q) => !answeredIds.includes(q.id))) return false;
  ctx.write(
    ctx.db
      .updateTable("core_work_items")
      .set({ status: "running", updated_at: ctx.now })
      .where("id", "=", w.id)
      .where("status", "=", "waiting"),
  );
  ctx.emit({
    kind: "workflow.event",
    payload: {
      instanceId: w.workflow_id,
      type: questionsEvent(w.id, w.planning_round),
      payload: { by: ctx.actor.id },
    },
  });
  return true;
}

export const questionAnswer = defineOperation({
  name: "question.answer",
  description:
    "Answer one question on a work item. Answering the same question twice is refused as already answered. The Workflow continues when the last blocking question is answered.",
  risk: "write",
  actors: ["human"],
  permission: "member",
  browserOnly: true,
  input: z.object({ questionId, answer: z.string().min(1).max(8_000) }),
  output: z.object({ answered: z.boolean(), roundComplete: z.boolean() }),
  async handler(input, ctx) {
    const q = await ctx.db
      .selectFrom("core_questions")
      .selectAll()
      .where("id", "=", input.questionId)
      .executeTakeFirst();
    if (!q) throw new OperationError("not_found", "no such question");
    if (q.status !== "open") throw new OperationError("conflict", `question already ${q.status}`);
    await assertCanAnswer(ctx, q.assignee_user_id);
    answer(ctx, q, input.answer, input.answer === q.default_answer);
    const roundComplete = await closeRoundIfDone(ctx, [q.id]);
    return { answered: true, roundComplete };
  },
});

export const questionAcceptDefaults = defineOperation({
  name: "question.acceptDefaults",
  description:
    "Accept the default answer for every remaining open question on a work item that has one. Never covers security & privacy questions or irreversible ones: those must be answered one by one (ADR 0042).",
  risk: "write",
  actors: ["human"],
  permission: "member",
  browserOnly: true,
  input: z.object({ workItemId }),
  output: z.object({
    accepted: z.array(z.string()),
    skipped: z.array(z.object({ id: z.string(), why: z.string() })),
    roundComplete: z.boolean(),
  }),
  async handler(_input, ctx) {
    const w = requireWorkItem(ctx);
    const open = await ctx.db
      .selectFrom("core_questions")
      .selectAll()
      .where("work_item_id", "=", w.id)
      .where("status", "=", "open")
      .execute();
    const accepted: string[] = [];
    const skipped: { id: string; why: string }[] = [];
    for (const q of open) {
      if ((NEVER_BULK_ACCEPTED_DOMAINS as readonly string[]).includes(q.domain)) {
        skipped.push({ id: q.id, why: "security & privacy questions are answered one by one" });
      } else if (q.irreversible) {
        skipped.push({ id: q.id, why: "irreversible questions are answered one by one" });
      } else if (q.default_answer === null) {
        skipped.push({ id: q.id, why: "no default" });
      } else {
        await assertCanAnswer(ctx, q.assignee_user_id);
        answer(ctx, q, q.default_answer, true);
        accepted.push(q.id);
      }
    }
    const roundComplete = accepted.length > 0 ? await closeRoundIfDone(ctx, accepted) : false;
    return { accepted, skipped, roundComplete };
  },
});

export const questionEscalate = defineOperation({
  name: "question.escalate",
  description:
    "A work item's blocking questions timed out: reassign the open ones to the backup owner (the policy's backupOwner, else the first approver). Never answers them (ADR 0042).",
  risk: "write",
  actors: ["agent"],
  permission: "signed-in",
  input: z.object({ workItemId }),
  output: z.object({ escalated: z.number(), to: z.string().nullable() }),
  async handler(_input, ctx) {
    const w = requireWorkItem(ctx);
    const to = await backupOwnerId(ctx.db, w.org_id, ctx.scope.policy);
    const open = await openBlocking(ctx, w.id);
    if (open === 0) return { escalated: 0, to };
    ctx.write(
      ctx.db
        .updateTable("core_questions")
        .set({ assignee_user_id: to, escalated_at: ctx.now })
        .where("work_item_id", "=", w.id)
        .where("status", "=", "open")
        .where("blocking", "=", 1),
    );
    ctx.emit({
      kind: "notify",
      payload: {
        event: "question.escalated",
        userId: to,
        workItemId: w.id,
        title: `Questions waiting too long on ${w.title}`,
        url: `/?item=${w.id}`,
      },
    });
    return { escalated: open, to };
  },
});

async function assertCanAnswer(ctx: HandlerContext, assignee: string | null) {
  if (assignee === ctx.actor.id) return;
  const w = requireWorkItem(ctx);
  const approvers = await approverIds(ctx.db, w.org_id, ctx.scope.policy);
  if (!approvers.includes(ctx.actor.id)) {
    throw new OperationError("forbidden", "this question is assigned to someone else");
  }
}

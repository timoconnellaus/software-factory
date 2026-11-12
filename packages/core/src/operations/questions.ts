// The Question object (ADR 0042, amended by ADR 0300): asked by the foreman (V1's spec rounds,
// Workflow v1–v4) or the planning agent (spec 20), answered by people. In V1 a blocking question
// pauses the Workflow like a gate; when the last blocking question of a planning round is answered,
// the Workflow gets `questions-<item>-<round>`. A planning session's questions follow kim instead:
// the agent adds, edits, reorders and withdraws them freely, answers can be revised, and every
// change is an event in the planning log.
import { parseJson } from "@software-factory/db";
import {
  type PlanningQuestion,
  planningQuestionSchema,
  questionDeleteInputSchema,
  questionDraftSchema,
  questionFocusInputSchema,
  questionReorderInputSchema,
  questionUpdateInputSchema,
} from "@software-factory/runner-contract";
import { z } from "zod";
import { OperationError } from "../errors.ts";
import { newId } from "../ids.ts";
import { defineOperation, type HandlerContext } from "../operation.ts";
import { logPlanning, openSession, takeBackFromGate, wakeSession } from "../planning.ts";
import { approverIds, backupOwnerId } from "../scope.ts";
import { questionsEvent } from "../workflow-events.ts";
import { byJob, notifyAway, planningJob, planningJobFields } from "./planning.ts";
import { fencingToken, jobId, questionId, requireWorkItem, workItemId } from "./shared.ts";

/** Questions bulk accept never covers (ADR 0042). */
export const NEVER_BULK_ACCEPTED_DOMAINS = ["security", "privacy", "security-privacy"] as const;

/** Whether bulk accept (and "finish alone") may answer a question with its default (ADR 0042). */
export function bulkAcceptable(q: {
  domain?: string;
  irreversible?: boolean | number;
  default?: string | null;
}) {
  return (
    !(NEVER_BULK_ACCEPTED_DOMAINS as readonly string[]).includes(q.domain ?? "product") &&
    !q.irreversible &&
    q.default !== null &&
    q.default !== undefined
  );
}

/** The text an accepted default answers with: its values joined (kim's defaultAnswerText). */
export const defaultText = (values: string[]) => values.join(", ");

const matchOption = (options: string[], value: string) =>
  options.find((o) => o.trim().toLowerCase() === value.trim().toLowerCase());

/**
 * A question's options and default checked against its kind (kim's normalizeDefault): one value
 * except for multiple-choice, and choice values spelled as their options. Yes-no has Yes and No.
 */
export function normalizeQuestion(q: {
  kind: PlanningQuestion["kind"];
  options: string[];
  default?: string[] | null | undefined;
}): { options: string[]; defaults: string[] | null } {
  const kind = q.kind ?? "text";
  const options =
    kind === "yes-no" ? ["Yes", "No"] : kind === "text" || kind === "number" ? [] : q.options;
  if ((kind === "single-choice" || kind === "multiple-choice") && options.length < 2) {
    throw new OperationError("invalid_input", `a ${kind} question needs at least two options`);
  }
  const values = q.default ?? null;
  if (!values) return { options, defaults: null };
  if (kind !== "multiple-choice" && values.length !== 1) {
    throw new OperationError("invalid_input", `a ${kind} question takes exactly one default value`);
  }
  if (kind === "number" && !Number.isFinite(Number(values[0]))) {
    throw new OperationError("invalid_input", `default "${values[0]}" is not a number`);
  }
  if (kind === "text" || kind === "number") return { options, defaults: values };
  const normalized = values.map((v) => {
    const match = matchOption(options, v);
    if (!match) {
      throw new OperationError(
        "invalid_input",
        `default "${v}" is not one of the options: ${options.join(", ")}`,
      );
    }
    return match;
  });
  return { options, defaults: options.filter((o) => normalized.includes(o)) };
}

export const questionAsk = defineOperation({
  name: "question.ask",
  description:
    "Ask the people on a work item questions, each with a default and a recommendation (ADR 0042). Prefer recording a reversible choice as an assumption on the spec instead. Questions go to the project approver in V1 (decision-domain owners in milestone (c)). The Workflow asks V1 drafts (`defaultAnswer`); a planning job (spec 20) asks kim-shaped questions (`kind`, `default`, `recommendation`) and names its job instead of the work item.",
  risk: "write",
  actors: ["agent", "runner"],
  permission: "signed-in",
  input: z.object({
    workItemId: workItemId.optional(),
    jobId: jobId.optional(),
    fencingToken: fencingToken.optional(),
    // Parsed per caller below: V1 drafts from the Workflow, planning questions from a planning job.
    questions: z.array(z.record(z.string(), z.unknown())).min(1).max(20),
  }),
  output: z.object({
    questionIds: z.array(z.string()),
    numbers: z.array(z.number()),
    round: z.number(),
  }),
  scope: async (input) => (input.jobId ? { jobId: input.jobId } : { workItemId: input.workItemId }),
  async handler(input, ctx) {
    const w = requireWorkItem(ctx);
    let sessionId: string | null = null;
    let session: Awaited<ReturnType<typeof planningJob>>["session"] | null = null;
    if (ctx.actor.type === "runner") {
      if (!input.jobId || input.fencingToken === undefined) {
        throw new OperationError("invalid_input", "a planning job names its job and fencing token");
      }
      session = (
        await planningJob(ctx, {
          jobId: input.jobId,
          fencingToken: input.fencingToken,
          workItemId: input.workItemId,
        })
      ).session;
      sessionId = session.id;
    } else if (!input.workItemId) {
      throw new OperationError("invalid_input", "workItemId is required");
    }
    const parse = <T>(schema: z.ZodType<T>, raw: unknown, i: number): T => {
      const parsed = schema.safeParse(raw);
      if (!parsed.success) {
        throw new OperationError("invalid_input", `question ${i + 1}: ${parsed.error.message}`, {
          issues: parsed.error.issues,
        });
      }
      return parsed.data;
    };
    const approvers = await approverIds(ctx.db, w.org_id, ctx.scope.policy);
    const assignee = approvers.includes(w.requester_user_id)
      ? w.requester_user_id
      : (approvers[0] ?? null);
    const hours = ctx.scope.policy?.timeouts.questionHours ?? 48;
    const timeoutAt = new Date(Date.parse(ctx.now) + hours * 3_600_000).toISOString();
    const counters = await ctx.db
      .selectFrom("core_questions")
      .select((eb) => [eb.fn.max("number").as("n"), eb.fn.max("position").as("p")])
      .where("work_item_id", "=", w.id)
      .executeTakeFirst();
    let number = Number(counters?.n ?? 0);
    const alone: string[] = [];
    let position = Number(counters?.p ?? 0);
    const ids: string[] = [];
    const numbers: number[] = [];
    for (const [i, raw] of input.questions.entries()) {
      const id = newId("question");
      ids.push(id);
      numbers.push(++number);
      const base = {
        id,
        work_item_id: w.id,
        project_id: w.project_id,
        org_id: w.org_id,
        assignee_user_id: assignee,
        planning_round: w.planning_round,
        timeout_at: timeoutAt,
        asked_by: ctx.actor.id,
        created_at: ctx.now,
        number,
      };
      if (sessionId) {
        const q = parse(planningQuestionSchema, raw, i);
        const { options, defaults } = normalizeQuestion(q);
        const text = defaults ? defaultText(defaults) : null;
        ctx.write(
          ctx.db.insertInto("core_questions").values({
            ...base,
            kind: q.kind,
            domain: q.domain,
            prompt: q.prompt,
            context: q.context ?? null,
            options: JSON.stringify(options),
            default_values: defaults ? JSON.stringify(defaults) : null,
            default_answer: text,
            recommendation: text,
            recommendation_reason: q.recommendation ?? null,
            blocking: q.blocking ? 1 : 0,
            irreversible: q.irreversible ? 1 : 0,
            position: q.position ?? ++position,
            planning_session_id: sessionId,
            // "Finish alone" (ADR 0470): a bulk-acceptable question is accepted as it is asked,
            // recorded as the answer of the person who gave the instruction.
            ...(session?.finish_alone_by && text && bulkAcceptable({ ...q, default: text })
              ? {
                  status: "answered" as const,
                  answer: text,
                  accepted_default: 1,
                  accepted_alone: 1,
                  answered_by: session.finish_alone_by,
                  answered_at: ctx.now,
                  answer_revision: 1,
                }
              : {}),
          }),
        );
        if (session?.finish_alone_by && text && bulkAcceptable({ ...q, default: text })) {
          alone.push(id);
        }
      } else {
        const q = parse(questionDraftSchema, raw, i);
        ctx.write(
          ctx.db.insertInto("core_questions").values({
            ...base,
            domain: q.domain,
            prompt: q.prompt,
            context: q.context ?? null,
            options: JSON.stringify(q.options),
            default_answer: q.defaultAnswer ?? null,
            recommendation: q.recommendation ?? null,
            recommendation_reason: q.recommendationReason ?? null,
            blocking: q.blocking ? 1 : 0,
            irreversible: q.irreversible ? 1 : 0,
            kind: q.options.length ? "single-choice" : "text",
            default_values: q.defaultAnswer ? JSON.stringify([q.defaultAnswer]) : null,
            position: ++position,
          }),
        );
      }
    }
    if (sessionId) {
      // The planning agent's questions show up live; the owner hears once, when planning is ready.
      logPlanning(ctx, w.id, "question.asked", { questionIds: ids });
      for (const questionId of alone) {
        logPlanning(ctx, w.id, "answer.submitted", { questionId, revision: 1, alone: true });
      }
      ctx.change({ entity: "work_item", id: w.id, after: { questionsAsked: ids.length } });
      if (session) {
        await notifyAway(
          ctx,
          session,
          "planning.question",
          `${ids.length} new question${ids.length === 1 ? "" : "s"} on #${w.number}: ${w.title}`,
        );
      }
      return { questionIds: ids, numbers, round: w.planning_round };
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
    return { questionIds: ids, numbers, round: w.planning_round };
  },
});

/** A planning question of the job's own work item, for the agent's edits. */
async function agentQuestion(ctx: HandlerContext, id: string) {
  const q = await ctx.db
    .selectFrom("core_questions")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirst();
  if (!q || q.work_item_id !== ctx.scope.workItemId) {
    throw new OperationError("not_found", `no question ${id} on this work item`);
  }
  if (q.status === "withdrawn") throw new OperationError("conflict", "that question was withdrawn");
  return q;
}

export const questionUpdate = defineOperation({
  name: "question.update",
  description:
    "The planning agent edits one of its work item's questions (prompt, kind, options, default, recommendation, domain, blocking, irreversible). An answer it already has stands.",
  risk: "write",
  actors: ["runner"],
  permission: "signed-in",
  input: questionUpdateInputSchema.extend(planningJobFields),
  output: z.object({ questionId: z.string(), revision: z.number() }),
  scope: byJob,
  async handler(input, ctx) {
    await planningJob(ctx, input);
    const q = await agentQuestion(ctx, input.questionId);
    const p = input.patch;
    const kind = p.kind ?? q.kind;
    const currentDefaults = q.default_values ? parseJson<string[]>(q.default_values, []) : null;
    const { options, defaults } = normalizeQuestion({
      kind,
      options: p.options ?? parseJson<string[]>(q.options, []),
      default: p.default === undefined ? currentDefaults : p.default,
    });
    const text = defaults ? defaultText(defaults) : null;
    const revision = q.revision + 1;
    ctx.write(
      ctx.db
        .updateTable("core_questions")
        .set({
          kind,
          options: JSON.stringify(options),
          default_values: defaults ? JSON.stringify(defaults) : null,
          default_answer: text,
          recommendation: text,
          ...(p.prompt !== undefined ? { prompt: p.prompt } : {}),
          ...(p.context !== undefined ? { context: p.context } : {}),
          ...(p.recommendation !== undefined ? { recommendation_reason: p.recommendation } : {}),
          ...(p.domain !== undefined ? { domain: p.domain } : {}),
          ...(p.blocking !== undefined ? { blocking: p.blocking ? 1 : 0 } : {}),
          ...(p.irreversible !== undefined ? { irreversible: p.irreversible ? 1 : 0 } : {}),
          revision,
          updated_at: ctx.now,
        })
        .where("id", "=", q.id)
        .where("revision", "=", q.revision),
    );
    ctx.guardChanged("question unchanged since read");
    logPlanning(ctx, q.work_item_id, "question.updated", { questionId: q.id, revision });
    ctx.change({ entity: "question", id: q.id, after: { revision } });
    return { questionId: q.id, revision };
  },
});

export const questionDelete = defineOperation({
  name: "question.delete",
  description:
    "The planning agent withdraws one of its work item's questions. It leaves the list; its answer, if any, stays in the record.",
  risk: "write",
  actors: ["runner"],
  permission: "signed-in",
  input: questionDeleteInputSchema.extend(planningJobFields),
  output: z.object({ questionId: z.string(), withdrawn: z.boolean() }),
  scope: byJob,
  async handler(input, ctx) {
    await planningJob(ctx, input);
    const q = await agentQuestion(ctx, input.questionId);
    ctx.write(
      ctx.db
        .updateTable("core_questions")
        .set({ status: "withdrawn", updated_at: ctx.now })
        .where("id", "=", q.id),
    );
    logPlanning(ctx, q.work_item_id, "question.deleted", {
      questionId: q.id,
      reason: input.reason ?? null,
    });
    ctx.change({
      entity: "question",
      id: q.id,
      before: { status: q.status },
      after: { status: "withdrawn" },
    });
    return { questionId: q.id, withdrawn: true };
  },
});

export const questionReorder = defineOperation({
  name: "question.reorder",
  description:
    "The planning agent puts its work item's open questions in a new order: the ones named first, in that order, then the rest as they were.",
  risk: "write",
  actors: ["runner"],
  permission: "signed-in",
  input: questionReorderInputSchema.extend(planningJobFields),
  output: z.object({ order: z.array(z.string()) }),
  scope: byJob,
  async handler(input, ctx) {
    await planningJob(ctx, input);
    const w = requireWorkItem(ctx);
    const open = await ctx.db
      .selectFrom("core_questions")
      .select(["id", "position"])
      .where("work_item_id", "=", w.id)
      .where("status", "=", "open")
      .orderBy("position")
      .orderBy("created_at")
      .execute();
    const known = new Set(open.map((q) => q.id));
    const unknown = input.questionIds.filter((id) => !known.has(id));
    if (unknown.length) {
      throw new OperationError("invalid_input", `not open questions here: ${unknown.join(", ")}`);
    }
    const named = [...new Set(input.questionIds)];
    const order = [...named, ...open.map((q) => q.id).filter((id) => !named.includes(id))];
    for (const [i, id] of order.entries()) {
      ctx.write(ctx.db.updateTable("core_questions").set({ position: i }).where("id", "=", id));
    }
    logPlanning(ctx, w.id, "question.reordered", { order });
    return { order };
  },
});

export const questionFocus = defineOperation({
  name: "question.focus",
  description:
    "The planning agent brings one question to everyone's Planning view (or clears the focus with null).",
  risk: "write",
  actors: ["runner"],
  permission: "signed-in",
  input: questionFocusInputSchema.extend(planningJobFields),
  output: z.object({ questionId: z.string().nullable() }),
  scope: byJob,
  async handler(input, ctx) {
    const { session } = await planningJob(ctx, input);
    if (input.questionId) await agentQuestion(ctx, input.questionId);
    ctx.write(
      ctx.db
        .updateTable("core_planning_sessions")
        .set({ focused_question_id: input.questionId, updated_at: ctx.now })
        .where("id", "=", session.id),
    );
    logPlanning(ctx, session.work_item_id, "question.focused", { questionId: input.questionId });
    return { questionId: input.questionId };
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

/**
 * Queues the answer. A planning session's question may be answered again (`answer.revised`, kim's
 * revisable answers); any other is answered once. Planning answers go into the planning log.
 */
function answer(
  ctx: HandlerContext,
  q: {
    id: string;
    work_item_id: string;
    status: string;
    answer_revision: number;
    planning_session_id: string | null;
  },
  value: string | null,
  acceptedDefault: boolean,
  note: string | null = null,
  skipped = false,
  /** Accepted under this person's "finish alone" instruction (ADR 0470): recorded as theirs. */
  alone: string | null = null,
) {
  const revising = q.status === "answered";
  const revision = q.answer_revision + 1;
  ctx.write(
    ctx.db
      .updateTable("core_questions")
      .set({
        status: "answered",
        answer: value,
        note,
        skipped: skipped ? 1 : 0,
        answer_delivered_at: null,
        accepted_default: acceptedDefault ? 1 : 0,
        accepted_alone: alone ? 1 : 0,
        answered_by: alone ?? ctx.actor.id,
        answered_at: ctx.now,
        answer_revision: revision,
      })
      .where("id", "=", q.id)
      .where("status", "=", revising ? "answered" : "open")
      .where("answer_revision", "=", q.answer_revision),
  );
  ctx.guardChanged(revising ? `revise ${q.id} once` : `answer ${q.id} once`);
  if (q.planning_session_id) {
    logPlanning(ctx, q.work_item_id, revising ? "answer.revised" : "answer.submitted", {
      questionId: q.id,
      revision,
    });
  }
  ctx.change({
    entity: "question",
    id: q.id,
    before: { status: q.status },
    after: {
      answer: value,
      acceptedDefault,
      ...(note ? { note } : {}),
      ...(skipped ? { skipped } : {}),
      revision,
    },
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

const answerInput = z
  .object({
    questionId,
    answer: z.string().min(1).max(100_000).optional(),
    note: z.string().trim().max(4_000).optional(),
    /** Skip it: the planning agent decides (spec 26). Planning questions only. */
    skipped: z.boolean().optional(),
  })
  .refine((v) => v.skipped || v.answer !== undefined, {
    message: "an answer is required unless the question is skipped",
    path: ["answer"],
  });
const answerOutput = z.object({
  answered: z.boolean(),
  revised: z.boolean(),
  roundComplete: z.boolean(),
});

/** Answers or skips one question (question.answer, or planning.answer for planning questions). */
async function answerQuestion(
  input: z.output<typeof answerInput>,
  ctx: HandlerContext,
  options: { planningOnly?: boolean; proofForSensitive?: boolean } = {},
): Promise<z.input<typeof answerOutput>> {
  const q = await ctx.db
    .selectFrom("core_questions")
    .selectAll()
    .where("id", "=", input.questionId)
    .executeTakeFirst();
  if (!q) throw new OperationError("not_found", "no such question");
  // Security, privacy and irreversible questions keep their presence proof on the desktop until the
  // owner says otherwise (review of #71): only ordinary planning answers are proof-free.
  if (
    options.proofForSensitive &&
    ctx.origin.surface === "desktop" &&
    !ctx.presence &&
    ((NEVER_BULK_ACCEPTED_DOMAINS as readonly string[]).includes(q.domain) || q.irreversible)
  ) {
    throw new OperationError(
      "forbidden",
      "a security, privacy or irreversible question is answered with Touch ID on the desktop",
      { presenceRequired: true },
    );
  }
  if (options.planningOnly && !q.planning_session_id) {
    throw new OperationError(
      "invalid_input",
      "not a planning session's question: use question.answer",
    );
  }
  const revisable = q.planning_session_id !== null && q.status === "answered";
  if (q.status !== "open" && !revisable) {
    throw new OperationError("conflict", `question already ${q.status}`);
  }
  if (input.skipped && !q.planning_session_id) {
    throw new OperationError("invalid_input", "only a planning session's questions can be skipped");
  }
  await assertCanAnswer(ctx, q.assignee_user_id);
  if (input.skipped) answer(ctx, q, null, false, input.note || null, true);
  else {
    const value = input.answer ?? "";
    answer(ctx, q, value, value === q.default_answer, input.note || null);
  }
  if (q.planning_session_id) {
    await takeBackFromGate(ctx, requireWorkItem(ctx), "a person changed an answer");
    await wakeSession(ctx, requireWorkItem(ctx));
    return { answered: true, revised: revisable, roundComplete: false };
  }
  const roundComplete = await closeRoundIfDone(ctx, [q.id]);
  return { answered: true, revised: false, roundComplete };
}

export const questionAnswer = defineOperation({
  name: "question.answer",
  description:
    "Answer one question on a work item, optionally with a note, or skip a planning session's question (the planning agent decides it). A planning session's question can be answered again (a revised answer reaches the planning agent, and takes the spec back if it waits at the gate); any other question answered twice is refused as already answered. In V1's spec rounds the Workflow continues when the last blocking question is answered.",
  risk: "write",
  actors: ["human"],
  permission: "member",
  browserOnly: true,
  presenceDecidable: true,
  input: answerInput,
  output: answerOutput,
  async handler(input, ctx) {
    return answerQuestion(input, ctx);
  },
});

export const planningAnswer = defineOperation({
  name: "planning.answer",
  description:
    "Answer or skip one of a planning session's questions, as question.answer does, from the app or the desktop. On the desktop it needs no presence proof: answering the planner is a conversation, not a gate (the owner's decision of 2026-11-12, ADR 0042 and 0391 as amended). Refused for questions outside a planning session.",
  risk: "write",
  actors: ["human"],
  permission: "member",
  browserOnly: true,
  desktopDecidable: true,
  presenceDecidable: true,
  input: answerInput,
  output: answerOutput,
  async handler(input, ctx) {
    return answerQuestion(input, ctx, { planningOnly: true, proofForSensitive: true });
  },
});

const acceptOutput = z.object({
  accepted: z.array(z.string()),
  skipped: z.array(z.object({ id: z.string(), why: z.string() })),
  roundComplete: z.boolean(),
});

/** Accepts the open defaults bulk accept may cover (question.acceptDefaults, planning.acceptDefaults). */
export async function acceptDefaults(
  ctx: HandlerContext,
  options: { planningOnly?: boolean; alone?: string } = {},
): Promise<z.input<typeof acceptOutput>> {
  const w = requireWorkItem(ctx);
  const open = await ctx.db
    .selectFrom("core_questions")
    .selectAll()
    .where("work_item_id", "=", w.id)
    .where("status", "=", "open")
    .$if(!!options.planningOnly, (q) => q.where("planning_session_id", "is not", null))
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
      if (!options.alone) await assertCanAnswer(ctx, q.assignee_user_id);
      answer(ctx, q, q.default_answer, true, null, false, options.alone ?? null);
      accepted.push(q.id);
    }
  }
  const planning = open.some((q) => q.planning_session_id !== null && accepted.includes(q.id));
  if (planning) {
    await takeBackFromGate(ctx, w, "a person accepted defaults");
    await wakeSession(ctx, w);
  }
  const roundComplete =
    accepted.length > 0 && !planning ? await closeRoundIfDone(ctx, accepted) : false;
  return { accepted, skipped, roundComplete };
}

export const questionAcceptDefaults = defineOperation({
  name: "question.acceptDefaults",
  description:
    "Accept the default answer for every remaining open question on a work item that has one. Never covers security & privacy questions or irreversible ones: those must be answered one by one (ADR 0042).",
  risk: "write",
  actors: ["human"],
  permission: "member",
  browserOnly: true,
  presenceDecidable: true,
  input: z.object({ workItemId }),
  output: acceptOutput,
  async handler(_input, ctx) {
    return acceptDefaults(ctx);
  },
});

export const planningAcceptDefaults = defineOperation({
  name: "planning.acceptDefaults",
  description:
    "Accept the default answer of every open planning question on a work item that has one, as question.acceptDefaults does (never security & privacy or irreversible ones), from the app or the desktop. On the desktop it needs no presence proof (the owner's decision of 2026-11-12, ADR 0042 and 0391 as amended).",
  risk: "write",
  actors: ["human"],
  permission: "member",
  browserOnly: true,
  desktopDecidable: true,
  input: z.object({ workItemId }),
  output: acceptOutput,
  async handler(_input, ctx) {
    return acceptDefaults(ctx, { planningOnly: true });
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

export const planningFinishAlone = defineOperation({
  name: "planning.finishAlone",
  description:
    "A person tells the planning agent to finish alone, or takes it back (ADR 0470, the owner's approval of 2026-11-12). While on, every planning question bulk accept may cover is accepted with its default, the open ones now and each new one as the agent asks it, recorded as accepted under this person's instruction. Security & privacy, irreversible and no-default questions still wait for a person, and approving the spec stays a person's. Per session, off by default; changes requested at the gate turn it off. Only a person, in the app or the desktop.",
  risk: "write",
  actors: ["human"],
  permission: "member",
  browserOnly: true,
  desktopDecidable: true,
  input: z.object({ workItemId, on: z.boolean() }),
  output: z.object({ on: z.boolean(), accepted: z.array(z.string()) }),
  async handler(input, ctx) {
    const w = requireWorkItem(ctx);
    const session = await openSession(ctx, w.id);
    if (!session) throw new OperationError("conflict", "no open planning session");
    if (ctx.actor.type !== "human") {
      throw new OperationError("forbidden", "only a person can tell the planner to finish alone");
    }
    const already = session.finish_alone_by !== null;
    if (already === input.on) return { on: input.on, accepted: [] };
    ctx.write(
      ctx.db
        .updateTable("core_planning_sessions")
        .set({
          finish_alone_by: input.on ? ctx.actor.id : null,
          finish_alone_at: input.on ? ctx.now : null,
          updated_at: ctx.now,
        })
        .where("id", "=", session.id),
    );
    logPlanning(ctx, w.id, "finish.alone", { on: input.on });
    ctx.change({
      entity: "planning_session",
      id: session.id,
      before: { finishAlone: already },
      after: { finishAlone: input.on, by: ctx.actor.id },
    });
    if (!input.on) {
      await wakeSession(ctx, w);
      return { on: false, accepted: [] };
    }
    const { accepted } = await acceptDefaults(ctx, { planningOnly: true, alone: ctx.actor.id });
    if (!accepted.length) await wakeSession(ctx, w);
    return { on: true, accepted };
  },
});

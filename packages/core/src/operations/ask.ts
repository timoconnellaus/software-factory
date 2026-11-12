// One question asked outside a spec round (the babysitter's hold at its update bound, spec 53
// review). Its own module so the merge queue can ask without importing the questions operations.
import { newId } from "../ids.ts";
import type { HandlerContext, WorkItemRow } from "../operation.ts";
import { approverIds } from "../scope.ts";

/**
 * Asks one question as the calling actor, outside a spec round (the babysitter's hold at its update
 * bound, spec 53 review): to the approver question.ask would ask, numbered after the item's others,
 * not blocking (no round waits on it), and the person is told. Returns its id.
 */
export async function askOne(
  ctx: HandlerContext,
  w: WorkItemRow,
  q: {
    prompt: string;
    context: string;
    options: string[];
    defaultAnswer: string;
    recommendationReason: string;
  },
): Promise<string> {
  const approvers = await approverIds(ctx.db, w.org_id, ctx.scope.policy);
  const assignee = approvers.includes(w.requester_user_id)
    ? w.requester_user_id
    : (approvers[0] ?? null);
  const hours = ctx.scope.policy?.timeouts.questionHours ?? 48;
  const counters = await ctx.db
    .selectFrom("core_questions")
    .select((eb) => [eb.fn.max("number").as("n"), eb.fn.max("position").as("p")])
    .where("work_item_id", "=", w.id)
    .executeTakeFirst();
  const id = newId("question");
  ctx.write(
    ctx.db.insertInto("core_questions").values({
      id,
      work_item_id: w.id,
      project_id: w.project_id,
      org_id: w.org_id,
      assignee_user_id: assignee,
      planning_round: w.planning_round,
      timeout_at: new Date(Date.parse(ctx.now) + hours * 3_600_000).toISOString(),
      asked_by: ctx.actor.id,
      created_at: ctx.now,
      number: Number(counters?.n ?? 0) + 1,
      position: Number(counters?.p ?? 0) + 1,
      domain: "delivery",
      prompt: q.prompt,
      context: q.context,
      options: JSON.stringify(q.options),
      default_answer: q.defaultAnswer,
      recommendation: q.defaultAnswer,
      recommendation_reason: q.recommendationReason,
      blocking: 0,
      irreversible: 0,
      kind: "single-choice",
      default_values: JSON.stringify([q.defaultAnswer]),
    }),
  );
  if (assignee) {
    ctx.emit({
      kind: "notify",
      payload: {
        event: "question.asked",
        userId: assignee,
        workItemId: w.id,
        title: `A question on ${w.title}`,
        url: `/?item=${w.id}`,
      },
    });
  }
  ctx.change({ entity: "work_item", id: w.id, after: { questionsAsked: 1 } });
  return id;
}

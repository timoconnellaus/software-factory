// The planning session's vocabulary (spec 20, ADR 0300, 0350): the operations a planning job's
// harness may call through the channel, their inputs (the planning MCP server's tool schemas), and
// what news and waits answer. Shared by the cloud (operation inputs) and the harness (tool schemas),
// so the two can't drift. Runtime-neutral.
import { z } from "zod";

/** Operations a planning job may run over `/runner/v1/jobs/:id/planning` (ADR 0350). */
export const PLANNING_OPS = [
  "question.ask",
  "question.update",
  "question.delete",
  "question.reorder",
  "question.focus",
  "spec.revise",
  "chat.reply",
  "planning.news",
  "planning.peek",
  "planning.wait",
  "planning.yield",
  "planning.ready",
] as const;
export type PlanningOp = (typeof PLANNING_OPS)[number];

/** Question kinds, as kim has them (ADR 0042 as amended). */
export const QUESTION_KINDS = [
  "text",
  "single-choice",
  "multiple-choice",
  "yes-no",
  "number",
] as const;
export type QuestionKind = (typeof QUESTION_KINDS)[number];

/** Provenance tags on spec statements (ADR 0302). `[Qn]` names question n. */
export const PROVENANCE_TAGS = ["request", "repo", "parent", "assumption"] as const;
/** Matches every provenance tag in a text: `[Q3]`, `[request]`, `[repo]`, `[parent]`, `[assumption]`. */
export const PROVENANCE_PATTERN = /\[(Q\d+|request|repo|parent|assumption)\]/g;

/** Coverage categories every spec keeps (ADR 0302); a project may add its own. */
export const COVERAGE_CATEGORIES = [
  "scope",
  "data & permissions",
  "ux",
  "edge cases",
  "non-functional",
  "terminology",
] as const;

/** How long a person must pause after an answer before a wait is due (kim's 15 s). */
export const PLANNING_IDLE_MS = 15_000;
/** A chat message, or every open question answered, settles this fast (kim's 750 ms). */
export const PLANNING_SETTLE_MS = 750;
/**
 * PostToolUse takes news at most this often (ADR 0470). Kim takes its own interview at every step;
 * 2 s keeps a person's message from waiting behind a busy agent while bounding the reads.
 */
export const PLANNING_NEWS_THROTTLE_MS = 2_000;
/** The longest one `planning.wait` call is held on the channel; the Stop hook calls it again. */
export const PLANNING_WAIT_MAX_MS = 50_000;
/** An idle session may yield only after this long idle with nobody present (ADR 0300, 0301). */
export const PLANNING_YIELD_AFTER_MS = 5 * 60_000;

const defaultValue = z.union([
  z.string().trim().min(1).max(10_000),
  z.number().finite().transform(String),
  z.boolean().transform((v) => (v ? "Yes" : "No")),
]);

/** One question, as the planning agent writes it (kim's fields, in the factory's names). */
export const planningQuestionSchema = z.object({
  kind: z.enum(QUESTION_KINDS).default("text"),
  prompt: z.string().trim().min(1).max(10_000),
  /** Background a person needs, in Markdown. */
  context: z.string().max(20_000).optional(),
  /** The choices, for single- and multiple-choice. Yes-no questions have Yes and No. */
  options: z.array(z.string().trim().min(1).max(1_000)).max(100).default([]),
  /**
   * The recommended answer: one option (several for multiple-choice), a number, Yes/No, or
   * suggested text. People accept it with one click or in bulk.
   */
  default: z
    .union([defaultValue, z.array(defaultValue).min(1).max(100)])
    .transform((v) => (Array.isArray(v) ? v : [v]))
    .optional(),
  /** Why the default, in Markdown. */
  recommendation: z.string().max(20_000).optional(),
  /** Decision domain (ADR 0029): product, architecture, security, privacy, operations, … */
  domain: z.string().trim().min(1).max(40).default("product"),
  /** Whether the spec can't go to the gate without it. */
  blocking: z.boolean().default(true),
  /** Hard to undo (a migration, a public API): never bulk-accepted. */
  irreversible: z.boolean().default(false),
  /** Where it goes in the open list (0 first). Omitted: at the end. */
  position: z.number().int().nonnegative().optional(),
});
export type PlanningQuestion = z.input<typeof planningQuestionSchema>;

export const questionAskInputSchema = z.object({
  questions: z.array(planningQuestionSchema).min(1).max(20),
});
export const questionUpdateInputSchema = z.object({
  questionId: z.string().min(1),
  /** Only the fields given change. A changed question's answer, if any, stands. */
  patch: planningQuestionSchema
    .omit({ position: true })
    .partial()
    .extend({ default: planningQuestionSchema.shape.default.nullable() }),
});
export const questionDeleteInputSchema = z.object({
  questionId: z.string().min(1),
  reason: z.string().max(1_000).optional(),
});
export const questionReorderInputSchema = z.object({
  /** Open question ids in their new order; open questions not named keep their order after these. */
  questionIds: z.array(z.string().min(1)).min(1).max(100),
});
export const questionFocusInputSchema = z.object({
  /** The question everyone's view should go to; null clears the focus. */
  questionId: z.string().min(1).nullable(),
});

export const coverageItemSchema = z.object({
  category: z.string().trim().min(1).max(80),
  status: z.enum(["clear", "partial", "not-applicable"]),
  /** For partial: the question numbers that cover it (`[Qn]`). */
  questions: z.array(z.number().int().positive()).max(20).default([]),
  note: z.string().max(1_000).optional(),
});
export const clarificationSchema = z.object({
  /** The question number, when it came from a question. */
  question: z.number().int().positive().optional(),
  q: z.string().trim().min(1).max(2_000),
  a: z.string().trim().min(1).max(4_000),
  /** ISO date (YYYY-MM-DD) it was settled. */
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

/** The whole living spec (ADR 0302). Each revision replaces the last. */
export const specReviseInputSchema = z.object({
  title: z.string().max(200).optional(),
  /**
   * Goal / Scope / Out of scope / Acceptance criteria, in Markdown, with a provenance tag on every
   * statement: [Qn], [request], [repo], [parent] or [assumption].
   */
  specMd: z.string().min(1).max(100_000),
  acceptanceCriteria: z.array(z.string().min(1).max(1_000)).min(1).max(30),
  /** Reversible choices recorded instead of asked; each one is an [assumption]. */
  assumptions: z.array(z.string().min(1).max(1_000)).max(30).default([]),
  coverage: z.array(coverageItemSchema).max(30).default([]),
  /** The dated Q → A log. */
  clarifications: z.array(clarificationSchema).max(100).default([]),
  /** What this revision changed, in a line. */
  summary: z.string().max(500).optional(),
});
export type SpecRevision = z.input<typeof specReviseInputSchema>;

export const chatReplyInputSchema = z.object({
  text: z.string().trim().min(1).max(20_000),
  questionId: z.string().min(1).optional(),
  replyTo: z.string().min(1).optional(),
});
/**
 * How a hook confirms what the agent actually saw (spec 26): `ack` is the cursor of the last event
 * the hooks showed it, which marks everything up to there read; `hold` leaves what this call returns
 * unread until a later `ack`, so news a hook couldn't show (a timeout, a cut) comes again.
 */
const deliveryFields = {
  ack: z.number().int().nonnegative().optional(),
  hold: z.boolean().optional(),
};
export const planningNewsInputSchema = z.object({
  /** Events after this cursor. Omitted: after the last one the session was given. */
  cursor: z.number().int().nonnegative().optional(),
  ...deliveryFields,
  /** What the agent is doing, shown in the app's pill (the hook passes its last tool). */
  activity: z.string().max(200).optional(),
});
/** A hook's cheap look (a read): is there anything after `cursor` (default: the last delivered)? */
export const planningPeekInputSchema = z.object({
  cursor: z.number().int().nonnegative().optional(),
});
export const planningWaitInputSchema = z.object({
  cursor: z.number().int().nonnegative().optional(),
  ...deliveryFields,
  idleMs: z.number().int().min(0).max(600_000).default(PLANNING_IDLE_MS),
  timeoutMs: z.number().int().min(0).max(PLANNING_WAIT_MAX_MS).default(PLANNING_WAIT_MAX_MS),
});
export const planningYieldInputSchema = z.object({});
export const planningReadyInputSchema = z.object({
  /** Added by the harness: the cursor the hooks last showed you (spec 26). */
  ack: z.number().int().nonnegative().optional(),
  /** A line for the approver: what's settled, what's assumed. */
  note: z.string().max(2_000).optional(),
});

/**
 * What the agent may send, as MCP tool schemas (spec 26, review of #67): the cursor and delivery
 * fields belong to the hooks, which the model can't call, so its tools don't carry them. The
 * harness adds `ack` to `planning.ready` itself.
 */
export const PLANNING_TOOL_INPUTS = {
  "question.ask": questionAskInputSchema,
  "question.update": questionUpdateInputSchema,
  "question.delete": questionDeleteInputSchema,
  "question.reorder": questionReorderInputSchema,
  "question.focus": questionFocusInputSchema,
  "spec.revise": specReviseInputSchema,
  "chat.reply": chatReplyInputSchema,
  "planning.news": planningNewsInputSchema.omit({ cursor: true, ack: true, hold: true }),
  "planning.peek": z.object({}),
  "planning.wait": z.object({}),
  "planning.yield": planningYieldInputSchema,
  "planning.ready": planningReadyInputSchema.omit({ ack: true }),
} as const satisfies Record<PlanningOp, z.ZodType>;

/** Inputs by operation, without the job fields the relay adds. */
export const PLANNING_INPUTS = {
  "question.ask": questionAskInputSchema,
  "question.update": questionUpdateInputSchema,
  "question.delete": questionDeleteInputSchema,
  "question.reorder": questionReorderInputSchema,
  "question.focus": questionFocusInputSchema,
  "spec.revise": specReviseInputSchema,
  "chat.reply": chatReplyInputSchema,
  "planning.news": planningNewsInputSchema,
  "planning.peek": planningPeekInputSchema,
  "planning.wait": planningWaitInputSchema,
  "planning.yield": planningYieldInputSchema,
  "planning.ready": planningReadyInputSchema,
} as const satisfies Record<PlanningOp, z.ZodType>;

/** What the agent is told about each tool (the MCP server's descriptions). */
export const PLANNING_TOOL_DESCRIPTIONS: Record<PlanningOp, string> = {
  "question.ask":
    "Add one or more questions for the people on this work item. Ask only what a person must decide; give each a default (your recommended answer) and a recommendation (why). Record reversible choices as [assumption]s in the spec instead.",
  "question.update":
    "Edit a question (prompt, options, default, recommendation, kind…). Its answer, if any, stands.",
  "question.delete": "Withdraw a question that no longer matters. Say why.",
  "question.reorder": "Put the open questions in a new order, most important first.",
  "question.focus":
    "Bring a question to everyone's view (when you want an answer to it next). null clears.",
  "spec.revise":
    "Replace the living spec with a new revision: the whole spec every time (body, criteria, assumptions, coverage, clarifications). Tag every statement with its source: [Qn], [request], [repo], [parent] or [assumption].",
  "chat.reply": "Reply in the planning chat, optionally about a question or to a message.",
  "planning.news":
    "Answers, revised answers, chat and presence since you last looked. The hooks bring news on their own; call this only to check now.",
  "planning.peek": "Whether there is news since you last looked (the hooks use it).",
  "planning.wait":
    "Wait for news (the Stop hook does this for you when you end your turn). Due after a 15 s pause in answers, a chat message, or every open question answered.",
  "planning.yield":
    "Give up this session's runner slot. Only when the factory asks you to (a wait answers yield: true); a later answer resumes this conversation.",
  "planning.ready":
    "Ask for the spec gate: the spec is complete and every blocking question is answered. A person approves it or asks for changes, which arrive in the chat.",
};

/** One piece of news for the agent. */
export const planningNewsEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.enum(["answer.submitted", "answer.revised"]),
    cursor: z.number(),
    at: z.string(),
    questionId: z.string(),
    number: z.number().nullable(),
    prompt: z.string(),
    /** Null when the person skipped it: decide it yourself. */
    answer: z.string().nullable(),
    /** The answer's revision: a receipt is stamped for exactly this one. */
    revision: z.number(),
    skipped: z.boolean(),
    note: z.string().nullable(),
    acceptedDefault: z.boolean(),
    by: z.string(),
  }),
  z.object({
    type: z.literal("chat.message"),
    cursor: z.number(),
    at: z.string(),
    messageId: z.string(),
    text: z.string(),
    from: z.string(),
    questionId: z.string().nullable(),
    /** The question the message is about (kim's `about`), so the agent needn't look it up. */
    about: z
      .object({ questionId: z.string(), number: z.number().nullable(), prompt: z.string() })
      .nullable(),
    /** `gate`: the approver asked for changes at the spec gate. */
    kind: z.enum(["chat", "gate"]),
  }),
  z.object({
    type: z.literal("presence.changed"),
    cursor: z.number(),
    at: z.string(),
    present: z.array(z.string()),
  }),
]);
export type PlanningNewsEvent = z.infer<typeof planningNewsEventSchema>;

export const planningNewsSchema = z.object({
  workItemId: z.string(),
  cursor: z.number(),
  events: z.array(planningNewsEventSchema),
  openQuestions: z.number(),
  /** Names of the people with the Planning view open. */
  present: z.array(z.string()),
  /** The scheduler asked this session to give up its slot (ADR 0301). */
  yield: z.boolean(),
  /** The session is over (the spec gate was decided, or it moved): stop. */
  ended: z.boolean(),
});
export type PlanningNews = z.infer<typeof planningNewsSchema>;

/** `planning.wait`: news once due, or `due: false` when the wait ran its course. */
export const planningWaitSchema = planningNewsSchema.extend({
  due: z.boolean(),
  /** While not due: when to evaluate again at the latest (a person's pause ends then). */
  recheckAt: z.string().nullable(),
});
export type PlanningWait = z.infer<typeof planningWaitSchema>;

/** `planning.peek`: is there anything after the cursor? A read, so it costs no write. */
export const planningPeekSchema = z.object({
  /** The log's latest event id for the work item. */
  latest: z.number(),
  /** Whether any event the agent is told about (answers, chat, presence…) follows the cursor. */
  news: z.boolean(),
  yield: z.boolean(),
  ended: z.boolean(),
});
export type PlanningPeek = z.infer<typeof planningPeekSchema>;

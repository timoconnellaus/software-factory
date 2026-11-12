// The Planning tab's logic (spec 20, layout A), kept out of the components so it is tested directly:
// the session pill's state, provenance chips, what changed since the previous spec revision, and the
// gate bar's counts.
import { isSensitiveQuestion } from "@software-factory/runner-contract";
import type { OpOutput } from "./ops.ts";

export type PlanningView = OpOutput<"planning.get">;
export type PlanningQuestion = PlanningView["questions"][number];
export type PlanningSession = NonNullable<PlanningView["session"]>;

export interface Pill {
  /** Mockup `planning-session-states`: attached, idle, paused, waiting for runner, at the gate. */
  state: "attached" | "working" | "idle" | "paused" | "waiting" | "starting" | "gate" | "ended";
  label: string;
  /** The line under the pill (what the agent is doing, or what happens next). */
  detail: string | null;
}

/** The session pill, from the session and who is here. */
export function sessionPill(session: PlanningSession | null, presentCount: number): Pill | null {
  if (!session) return null;
  const runner = session.runner?.name ?? null;
  const on = runner ? ` · ${runner}` : "";
  if (session.status === "ended" || session.status === "moved") {
    return { state: "ended", label: "Planning agent · ended", detail: null };
  }
  if (session.waitingForRunner && runner) {
    return {
      state: "waiting",
      label: `Waiting for ${runner}`,
      detail: `Your answers are saved. The session continues when ${runner} is back.`,
    };
  }
  if (session.atGate) {
    return {
      state: "gate",
      label: `Planning agent · at the spec gate${on}`,
      detail: "The spec waits for a decision. Changes you ask for go back to the same session.",
    };
  }
  switch (session.status) {
    case "starting":
      return {
        state: "starting",
        label: `Planning agent · starting${on}`,
        detail: runner ? null : "Waiting for a runner with a free light slot.",
      };
    case "working":
    case "yielding":
      return {
        state: presentCount > 0 ? "attached" : "working",
        label: `Planning agent · ${presentCount > 0 ? "attached" : "working"}${on}`,
        detail: session.activity ? `${capitalise(session.activity)}…` : null,
      };
    case "idle":
      return {
        state: "idle",
        label: `Planning agent · waiting for answers${on}`,
        detail: "Answer when you like; the agent picks it up right away.",
      };
    default:
      return {
        state: "paused",
        label: "Planning agent · paused · resumes on your next answer",
        detail: runner
          ? `Your next answer or message resumes the session on ${runner}.`
          : "Your next answer or message resumes the session.",
      };
  }
}

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Provenance tags in spec text (ADR 0302), as they appear: `[Q3]`, `[request]`, `[assumption]`… */
export const TAG = /\[(Q\d+|request|repo|parent|assumption)\]/g;

/**
 * The spec's Markdown with each provenance tag turned into inline code the renderer shows as a chip
 * (`⟦Q3⟧`). Code spans and fenced code are left alone.
 */
export function markTags(md: string): string {
  let fenced = false;
  return md
    .split("\n")
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
      if (fenced) return line;
      return line
        .split(/(`[^`]*`)/)
        .map((part, i) => (i % 2 === 1 ? part : part.replace(TAG, (_m, tag) => `\`⟦${tag}⟧\``)))
        .join("");
    })
    .join("\n");
}

/** A chip's tag, from inline code `⟦…⟧`, or null for ordinary code. */
export function chipTag(code: string): string | null {
  return /^⟦(Q\d+|request|repo|parent|assumption)⟧$/.exec(code)?.[1] ?? null;
}

/** A block's text, normalised for comparing revisions: tags, Markdown marks and spaces don't count. */
export function blockKey(text: string): string {
  return text
    .replace(/⟦[^⟧]*⟧/g, "")
    .replace(TAG, "")
    .replace(/[`*_>#-]/g, "")
    .replace(/^\s*\d+\.\s+/, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** The blocks (lines that say something) of a spec revision, as keys. */
export function blocks(md: string | null | undefined): Set<string> {
  return new Set(
    (md ?? "")
      .split("\n")
      .map(blockKey)
      .filter((k) => k.length > 0),
  );
}

/** Whether a block of the current revision is new or changed since the previous one. */
export function isChanged(text: string, previous: Set<string> | null): boolean {
  if (!previous) return false;
  const key = blockKey(text);
  return key.length > 0 && !previous.has(key);
}

/** The gate bar's line: "6 of 8 answered · 4 defaults accepted · 2 assumptions · coverage 5/6". */
export function gateSummary(view: Pick<PlanningView, "questions" | "spec">): string {
  const answered = view.questions.filter((q) => q.status === "answered");
  const defaults = answered.filter((q) => q.acceptedDefault).length;
  const parts = [
    `${answered.length} of ${view.questions.length} answered`,
    `${defaults} default${defaults === 1 ? "" : "s"} accepted`,
  ];
  const assumptions = view.spec?.assumptions.length ?? 0;
  if (view.spec) parts.push(`${assumptions} assumption${assumptions === 1 ? "" : "s"}`);
  const coverage = view.spec?.coverage ?? [];
  if (coverage.length) {
    const settled = coverage.filter((c) => c.status !== "partial").length;
    parts.push(`coverage ${settled}/${coverage.length}`);
  }
  return parts.join(" · ");
}

/** The answer a question's form starts with: its default, else nothing. */
export function initialAnswer(q: Pick<PlanningQuestion, "kind" | "defaultValues" | "answer">) {
  if (q.answer) {
    return q.kind === "multiple-choice" ? q.answer.split(", ") : [q.answer];
  }
  return q.defaultValues ?? [];
}

/** The options a question offers, by kind: yes-no has Yes and No; text and number none. */
export function questionOptions(q: Pick<PlanningQuestion, "kind" | "options">): string[] {
  if (q.kind === "yes-no") return ["Yes", "No"];
  if (q.kind === "text" || q.kind === "number") return [];
  return q.options;
}

/** The answer text for chosen values: one value, or several joined as the default is. */
export function answerText(kind: string, values: string[]): string {
  const kept = values.map((v) => v.trim()).filter(Boolean);
  return kind === "multiple-choice" ? kept.join(", ") : (kept[0] ?? "");
}

/** The plan's blocks, as the server compares them (spec 27): one segmentation for both. Spec 21:
 * what an answer sets in its mockup, and a mockup's frame size, shared with the server. */
export {
  appliedValues,
  changedSpan,
  dedent,
  editAnswer,
  editWrote,
  foldSpace,
  frameSize,
  normalizeLines,
  type PlanBlock,
  planBlocks,
} from "@software-factory/runner-contract";
/** The one sensitive-question check, shared with the server (ADR 0042, review of #71). */
export { isSensitiveQuestion };

/** Whether "Accept remaining defaults" covers a question (ADR 0042). */
export function bulkAcceptable(q: PlanningQuestion): boolean {
  return q.status === "open" && q.defaultAnswer !== null && !isSensitiveQuestion(q);
}

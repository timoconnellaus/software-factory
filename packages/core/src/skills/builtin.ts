// Built-in skills (spec 52, ADR 0513): shipped with their stage type, versioned with it. An org may
// extend one (its text after the built-in's) or replace it, except the protected ones: the `checks`
// type's skills judge the work, so they can only be added to, and that is a person's decision (Q16).

export interface BuiltinSkill {
  id: string;
  type: string;
  slug: string;
  name: string;
  description: string;
  body: string;
  /** It judges the work: org text may only add to it, as a policy change (Q16). */
  protected: boolean;
}

const b = (s: Omit<BuiltinSkill, "id">): BuiltinSkill => ({
  ...s,
  id: `builtin:${s.type}:${s.slug}`,
});

export const BUILTIN_SKILLS: readonly BuiltinSkill[] = [
  b({
    type: "interview-planning",
    slug: "run-an-interview",
    name: "Run an interview",
    description: "How to interview the requester and turn the answers into a plan and a spec.",
    body: [
      "Ask one question at a time, each with a recommended answer the person can accept as it is.",
      "Write down every answer in the plan as you go. Stop asking once the acceptance criteria are",
      "testable and the scope is clear; say what you left out and why.",
    ].join("\n"),
    protected: false,
  }),
  b({
    type: "checks",
    slug: "review-the-change",
    name: "Review the change",
    description: "How the reviewer checks a change against its spec before the merge gate.",
    body: [
      "Read the spec's acceptance criteria first, then the diff. For each criterion, name the check",
      "that proves it on this commit, or say it isn't proven. Never pass a criterion on the runner's",
      "word alone. List anything the change does that the spec didn't ask for.",
    ].join("\n"),
    protected: true,
  }),
];

export const BUILTIN_BY_ID: ReadonlyMap<string, BuiltinSkill> = new Map(
  BUILTIN_SKILLS.map((s) => [s.id, s]),
);

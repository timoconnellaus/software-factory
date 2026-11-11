// The model-role registry (ADR 0018): the ONE place in the code that names model ids. Everything
// else asks for a role. A guard test fails if a model id appears in any other source file.
import type { ModelRole } from "@software-factory/runner-contract";

/** Default role → model map. A project's `.factory/policy.json` `modelRoles` overrides it. */
export const DEFAULT_MODEL_ROLES: Readonly<Record<ModelRole, string>> = {
  triage: "claude-sonnet-5-5",
  implement: "claude-opus-5-5",
  // Must differ from `implement`: the reviewer is independent (ADR 0020).
  review: "claude-fable-5-2",
  summarise: "claude-haiku-5-5",
};

export function resolveModel(
  role: ModelRole,
  overrides: Partial<Record<ModelRole, string>> = {},
): string {
  return overrides[role] ?? DEFAULT_MODEL_ROLES[role];
}

/** True when the reviewer would run the same model as the implementer (spec 04, criterion 5). */
export function reviewerMatchesImplementer(
  overrides: Partial<Record<ModelRole, string>> = {},
): boolean {
  return resolveModel("review", overrides) === resolveModel("implement", overrides);
}

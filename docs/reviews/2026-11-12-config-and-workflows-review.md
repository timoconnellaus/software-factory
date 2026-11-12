# Fable's review of the settings and workflows design

**Verdict:** build the settings editor first, but fix findings 1, 3 and 4 before it ships. "The workflow is data, the invariants are code" doesn't hold as drawn, because the validator checks the shape of a workflow while the real ways to loosen policy are text and agent profiles.

## Critical
1. **Locked steps are editable where it matters.** Changing verify's *instructions* can gut `factory/verify`, and changing the merge gate's *who* changes who approves. → Locked steps take their prompt from code and their approvers from `approvers`. Project text never reaches the verify or reviewer prompts. *(Mockup fixed.)*
2. **When triage picks the workflow, an AI is picking the policy.** If triage picks "Dependency bump" (which has no spec step) for a feature, the spec gate is skipped. → Keep the spec gate, verify, merge and the retry cap as floors in the engine, computed from size and policy whatever the workflow. A workflow may only *add* steps. Log the choice as a binding foreman decision, and let a person re-route.
3. **Making "who may merge a loosening" a per-project setting is circular.** One PR could loosen both that rule and the policy itself. → Evaluate a settings PR under the **base-branch** policy. Put the minimum in the org floor, and let a project only tighten it.

## High
4. **An invalid policy on main halts the project**, including items already running. `recordPolicy` sets the policy SHA without checking order, so webhooks that arrive out of order can leave an older policy in force. `push.observe` reads only `policy.json`. → Run the validator as a required check on any PR that touches `.factory/`. Keep the last valid policy for items already running. Only apply a push whose SHA is the branch head.
5. **Pinning a running item to its policy SHA isn't how it works today.** Only the retry limit and timeouts are pinned; gates, the job profile, WIP and the spec decision all read the *current* policy. → Pin the workflow's *shape*, and evaluate gates and the harness against the **stricter** of the pinned and current policy.
6. **Agent profiles can widen the harness.** The harness settings already allow `bypassPermissions` on any stage, plus 100 allow rules and 100 hosts. → Set a ceiling per stage kind in code (verify and triage never get bypass). An agent may only narrow what the project's `harness` allows. Every change to the harness, hosts or instructions counts as loosening.
7. **An agent step can look like a gate.** "Security review" reads as a control but is only advisory. → Give steps two kinds, `work` and `gate`, where a gate means a person. An agent's verdict can only send work back or escalate, and the UI labels it "advisory".

## Medium
8. **The mockup's impact summary was wrong.** Autonomous frees agents to *spend* and act *outbound*, not to *write*. Adding an approver is loosening. Merge and deploy are `ALWAYS_REVIEW` in code, not the floor. → Compute the summary by diffing `decide()` over every actor and risk class, recompute it server-side, and treat anything unclassified as loosening. *(Mockup fixed.)*
9. **Gaps in the PR flow:**
   - Allow one open settings PR per project, updated in place, and rebase the form when the policy SHA moves.
   - An attached PR skips the merge queue, so make the validator the main check.
   - Proposing can be any member; merging is only for base-policy approvers.
   - Confirm that GitHub write access can't merge around the app.
   - "Open PR" needs a registry operation (human-only, `self-modify`), not a GitHub call from the app.
10. **Loops and cost.** "If it fails → go to" can form cycles. → Set a step budget and a spend ceiling per item, and require any cycle to pass through a person.

## Coherence
- **One owner per fact:**
  - `policy.json` holds what the engine enforces: autonomy, thresholds, limits, approvers, the harness ceiling.
  - Workflows hold step order and added steps.
  - Agents hold the model role and can only narrow the harness.
- **Duplicates to remove:** `spec.requiredFrom` and a spec step's condition; harness, requires and modelRoles keyed by stage and per agent; retry limit and a per-step retry.
- **Per org:** the floor (an env var today), the minimum approval for loosening, the harness ceiling, and shared agents.

## Engine
A full interpreter is expensive. Step names are the replay API, the existing Workflow versions have to keep running until they drain, and most of `work-item.ts` (CI waits, conflicts, the merge queue) stays in code anyway.

**A cheaper middle ground:** a `runV6` that keeps the fixed skeleton with **typed slots** (after spec, before verify, after verify), each holding agent work steps or person gates. Named workflows become presets over those slots. The default is empty slots, which behaves exactly like v4, so the gate rules come from the structure itself rather than from a validator.

## To check
- ADR 0230's `check-merge` auto-merges fixes under `.factory/checks/`. Confirm it matches paths exactly before `.factory/workflows/` and `.factory/agents/` exist.

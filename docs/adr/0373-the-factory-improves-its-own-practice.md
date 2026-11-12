# ADR 0373: The factory improves its own practice; policy stays with people

Status: accepted, 2026-11-12 (interview, with prior art from Cursor Bugbot's learned rules, Warp
Factories and Devin). Spec [09](../specs/09-factory-config-in-the-app.md) M3. Amends
[ADR 0008](0008-autonomy-presets-and-floor.md), [ADR 0009](0009-factory-config-in-git.md)'s
self-improvement PRs, [ADR 0011](0011-audit-journal-is-the-metrics.md),
[ADR 0027](0027-evals.md) and AGENTS.md's "self-modify always goes to a human".

## Context
The owner's goal is a factory that gets more effective and more efficient over time, without a
person approving every change. Tools that do this well apply advisory changes automatically and let
evidence promote or retire them. Cursor's Bugbot is the example: its learned rules are candidates,
promoted when signal builds and disabled when it turns negative. None of these tools lets an AI
loosen permissions.

## Decision
1. **Config changes come in two tiers.**
   - **Practice** is *how* work is done. The factory applies these itself (actor `self-improve`):
     - agent and step instructions, but never the verify or reviewer prompts;
     - an agent's tier, or the project's model preferences, for work steps;
     - adding an advisory `work` step, or removing one the improver added;
     - a new workflow made from existing steps, with no gate removed;
     - checks under `.factory/checks/`, through PRs as before (ADR 0230);
     - the retry limit and timeouts, within bounds in code;
     - the order of the review packet sections.
   - **Policy** is *what's allowed*: autonomy and overrides, approvers, gate steps, harness
     permissions that widen, the floor, the spec threshold, and the verify/reviewer prompts and
     models. These go to a person, as an inbox proposal with evidence.
   - `policyImpact` (ADR 0370) decides the tier. Anything it can't classify is policy.
2. **Every practice change is a trial.**
   - Its lifecycle is candidate → trial → promoted or disabled.
   - A trial applies to the next N items of one workflow (default 5), and only one trial runs per
     workflow at a time.
   - It is **promoted** if outcomes hold up: verify pass rate, send-backs, and edits at gates must
     be no worse than the previous version over the same kind of work.
   - It is **rolled back automatically** if they don't. Within equal outcomes, cost and time
     decide.
   - Before a trial starts, a different model role (`review`) critiques the candidate. The critic
     can only veto.
3. **There are limits.**
   - A weekly cap on changes (default 3 per project).
   - A weekly digest of what changed and why, with one-click revert.
   - A per-project off switch (`improve.enabled`).
   - A runner owner may opt their runner out of trials.
4. **Signals.**
   - Every run records tokens in/out per model, the harness, model and runner, time per step, and
     retries.
   - Gates prompt for a short reason on send-back, edit or reject.
   - Comparisons are like for like (same harness and model class).
   - On subscription runners, cost means time and rate-limit hits. Tokens × a price table count
     only for API-key runners.
5. **An adjudicator reduces approvals** (ADR 0374), separately from the improver.

## Consequences
- AGENTS.md's rule narrows: loosening and policy changes stay human-only; practice changes may be
  applied by the factory under these guardrails.
- Verify and the merge gate stay fixed and independent of anything the improver edits. That is the
  safety argument: a bad practice change shows up as failed verifies or send-backs, and the trial
  rolls it back.
- Eval replay of a candidate before its trial (ADR 0027) is the next step after V1.

> Amended 2026-11-12 (spec 09 M3, as built): V1's improver drafts with two rules, not a model.
> The rules are a repeated failing check (an instruction for the builder) and a run of first-time
> passes (the builder to the `light` tier). So the critic step waits for model-drafted changes.
> Practice is narrowed in code to agents' tier and instructions, plus adding the default
> **Builder** agent. Trials are per project, one at a time, and items join when they're created.
> Usage comes from the harness transcript as a `usage` artifact. The digest is a list in Settings.

> Amended 2026-11-12 ([ADR 0503](0503-skills-are-shared-by-the-org-and-attached-where-used.md), spec 52, not built yet): skill edits are trialled like other practice changes, but the factory only **proposes** them; a person accepts. Edits to the Checks reviewer's skills are policy.

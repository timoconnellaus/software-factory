# ADR 0230: A factory incident's check-only fix may merge without a person

Status: accepted, 2026-11-11 (V1 step 4, verify + connector + incidents). Amends
[ADR 0008](0008-autonomy-presets-and-floor.md). Answers the open item in
[`handoff.md`](../handoff.md) and the [V1 scope](../v1-scope.md) ("incident fixes that only add
checks or evals auto-merge once their regression eval passes").

## Context
V1's improvement loop opens a factory incident whenever a PR is sent back or a run's retries are
exhausted. Most incidents are best fixed by adding a check (so the same slip is caught next time)
and a regression case proving the check catches it. If each of those waits at the merge gate, the
loop is slow and the gate fills with low-risk items. ADR 0008 says merge, deploy and self-modify
always go to a person, and `.factory/` diffs are self-modify (ADR 0036). An exception must be
narrow, enforced in code, and impossible for an agent to widen.

## Decision
- A new risk class, **`check-merge`**, carried by exactly one operation, **`pr.autoMerge`** (actor:
  the foreman). It is not in `ALWAYS_REVIEW`. **Every shipped autonomy policy denies it** for every
  non-human actor; a project opts in only with an override in its `.factory/policy.json`
  (`"overrides": { "agent": { "check-merge": "allow" } }`). That file is read from the default
  branch only, and changing it is self-modify, so only a person can turn this on. The floor still
  applies and can deny or review it.
- Even when the gate allows the call, the **handler** refuses (`denied`) unless all of these hold:
  1. the work item is a **factory incident** (`kind = 'incident'`);
  2. **GitHub's compare** of the default branch with the head SHA (never the runner's report) lists
     only **added** files, every one under **`.factory/checks/`** or **`evals/regressions/`**, at least
     one of them a regression case, fewer than 300 files, no `.`/`..` path segments. Any modified,
     renamed or removed file, `.factory/policy.json`, skills, prompts, context or eval code is out;
  3. **CI is green on the head SHA** as GitHub reports it (the CI run includes the evals suite, which
     runs every `.factory/checks/` check over the repo and every regression case: this is "the
     regression eval passed");
  4. the **review packet for that SHA passed** (so `factory/verify` is green), and the head hasn't moved.
  Then the App merges the PR (`merge`, bound to the SHA). Branch protection still requires `ci` and
  `factory/verify` from the App, so GitHub enforces 3 and 4 a second time.
- The Workflow (v2) tries `pr.autoMerge` first for incident items only; any refusal (not opted in,
  not check-only, red CI) falls through to the normal `pr.merge` merge gate. Every attempt, allowed
  or refused, is in the audit journal.
- `evals/regressions/` is narrower than the handoff's "`evals/`": eval *code* runs in CI, so adding
  it is not data-only; only regression case files are.

## Consequences
- The improvement loop closes without a person for the commonest fix, and only tightens: a check can
  only add failures, a regression case only adds an assertion.
- A bad check (one that flags good code) fails CI on the next PR and opens its own incident; reverting
  it is a normal reviewed change.
- `RISK_CLASSES` has a ninth class. Audit and pending-action rows record it like any other.

> Amends [ADR 0008](0008-autonomy-presets-and-floor.md): "merge, deploy and self-modify always need
> a person" keeps holding for `pr.merge`, deploys and every `.factory/` change except this one, which
> a person pre-approves per project in policy.

> **Superseded** 2026-11-12 by [ADR 0515](0515-merges-may-be-approved-automatically-dark-factory-mode.md) (spec 52, question 11): the owner wants this to work "optionally in dark factory mode. Where it merges too". An incident's check-only fix merges with no person only when the workflow's `autoApprove` is on and its conditions hold, like any change. `pr.autoMerge` stops being called from the Workflow version that adds the setting (spec 52 PR (e)); `check-merge` stays in `RISK_CLASSES` so old audit rows read, and no policy allows it.

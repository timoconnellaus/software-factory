# Checks: what proves a criterion

The merge gate marks an acceptance criterion **Proven** only when a check that actually ran on the
head commit is tied to it ([ADR 0501](adr/0501-the-factory-runs-the-checks-and-only-executed-evidence-proves-a-criterion.md),
[spec 51](specs/51-verify-from-the-factorys-own-evidence.md)). The reviewer agent's word is shown,
labelled as opinion, and never proves anything.

## Setting up checks

A project has checks when either of these is true:

- **Declared checks.** The project's config has `checks`: at most ten
  `{ "name": "tests", "run": "pnpm test", "timeoutMinutes": 20, "proves": true }` (`proves` is
  optional), and a workflow may add its own.
  The runner host runs them on the head commit after every build. Declare the install first
  (`pnpm install --frozen-lockfile`); later checks use what it installed.
- **Required CI checks.** The config's `protection.requiredChecks` names CI check runs (default
  `ci`). Only a required one that reports on the commit can prove a criterion; a CI job a PR adds
  never does.

Lint, typecheck and format checks run, but never prove a behavioural criterion.

There is no screen to declare checks yet. Change the config through `config.save` (a change that
removes or changes a check loosens policy, so it waits for an approver).

## Tying a criterion to a check

A tie is a `[checks: tests, e2e]` tag at the end of a criterion, read by `proveCriteria`
(`packages/core/src/verify/proof.ts`). `[checks: none]` says no declared check can prove it, shown
as "not covered by a check". Where the tie comes from:

- **An item with a spec** (medium and large by default): the approved spec's criteria. A person
  approved the spec, so the tie is theirs.
- **An item without a spec** (small by default, `spec.requiredFrom` is `medium`), from the Workflow's `triage-ties` feature:
  triage. It is given the names that can prove anything (`checks.provable`: the declared checks,
  then the required CI checks) and returns `criterionChecks`, one entry per criterion.
  `workItem.triage` keeps only those names (any other is dropped and journaled, and that criterion
  is untied, so Not proven), writes the tags into triage's spec, and refuses once the item has left
  triage, so no later stage can add or change a tie. Before `triage-ties` a small item had no ties at all, so
  none of its criteria could ever be Proven.
- **The reviewer** may name checks too. They are shown, but never prove anything.

A criterion tied in a person-approved spec is **Proven** only when one of its checks passed on the
head commit: a declared check the runner host ran, or a required CI check that is green.

Triage is an agent, so a criterion it tied is never called Proven: when its check passed the gate
says "Passed `tests`, the check triage named (not checked by a person)", and counts it apart
("Proven 2 of 3 · passed the check triage named 4 of 5"). Auto-approval (ADR 0515) counts only
person-approved ties.

## Which checks can prove

Only a check that runs tests, by its name or command (`test`, `e2e`, `vitest`, …). Never a setup
check (install, build) or a static one (lint, typecheck, format). A declared check can say so
itself: `"proves": false`, or `"proves": true` for one the default doesn't recognise (that loosens
the config, so it waits for an approver). Triage is offered only checks that can prove.

## What the gate says

- **No checks set up at all**: "No checks are set up for this project, so nothing can be proven."
  There is no count, because nothing could have proven a criterion.
- **Checks set up**: the count of criteria proven, and for each one not proven, why: no check is
  named for it, the named check didn't pass on the commit, the check can't prove a criterion (a
  static check), or only the reviewer named it.

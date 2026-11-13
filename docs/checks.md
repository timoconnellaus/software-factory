# Checks: what proves a criterion

The merge gate marks an acceptance criterion **Proven** only when a check that actually ran on the
head commit is tied to it ([ADR 0501](adr/0501-the-factory-runs-the-checks-and-only-executed-evidence-proves-a-criterion.md),
[spec 51](specs/51-verify-from-the-factorys-own-evidence.md)). The reviewer agent's word is shown,
labelled as opinion, and never proves anything.

## Setting up checks

A project has checks when either of these is true:

- **Declared checks.** The project's config has `checks`: at most ten
  `{ "name": "tests", "run": "pnpm test", "timeoutMinutes": 20 }`, and a workflow may add its own.
  The runner host runs them on the head commit after every build. Declare the install first
  (`pnpm install --frozen-lockfile`); later checks use what it installed.
- **Required CI checks.** The config's `protection.requiredChecks` names CI check runs (default
  `ci`). Only a required one that reports on the commit can prove a criterion; a CI job a PR adds
  never does.

Lint, typecheck and format checks run, but never prove a behavioural criterion.

There is no screen to declare checks yet. Change the config through `config.save` (a change that
removes or changes a check loosens policy, so it waits for an approver).

## Tying a criterion to a check

A criterion is tied to a check by the approved spec: a criterion that ends with
`[checks: tests, e2e]`. A person approved the spec, so the tie is theirs.

## What the gate says

- **No checks set up at all**: "No checks are set up for this project, so nothing can be proven."
  There is no count, because nothing could have proven a criterion.
- **Checks set up**: the count of criteria proven, and for each one not proven, why: no check is
  named for it, the named check didn't pass on the commit, the check can't prove a criterion (a
  static check), or only the reviewer named it.

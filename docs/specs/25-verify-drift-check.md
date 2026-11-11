# Spec 25: Verify checks drift from the spec

Read first: ADRs [0306](../adr/0306-verify-checks-drift-from-the-spec.md) and
[0020](../adr/0020-verification-and-review-packet.md); [spec 04](04-verify-and-pr.md).

## Goal
The reviewer sees where the build departed from the approved spec, and the spec that ships says
what was actually built.

## Scope
- **The verify run** adds `drift` to its result: work outside scope, scope items with no matching
  change, and decisions the build made that the spec didn't. Each entry gives evidence (a file and
  line, or a spec line).
- **The review packet** gains a Drift section, in the order set by the project's policy.
- **Blocking**: drift is a warning unless the project's evidence policy sets `drift: "blocking"`.
- **On merge**, the spec file on the branch gets an "As built" section listing accepted drift,
  committed before the merge.

## Acceptance criteria
1. A build that adds an endpoint the spec's Out of scope excludes shows a drift entry naming the
   file, and `factory/verify` stays green unless drift is blocking for the project.
2. With `drift: "blocking"`, the same build fails verify, with the drift as the reason.
3. After merge, `docs/specs/NN-*.md` on main has an "As built" section matching the packet's
   accepted drift.

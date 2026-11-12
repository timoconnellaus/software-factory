# ADR 0500: The factory guards the tests the build is judged by

Status: accepted, 2026-11-12 ([spec 51](../specs/51-verify-from-the-factorys-own-evidence.md), PR A).
Amends [ADR 0020](0020-verification-and-review-packet.md) (a new review packet section) and
[ADR 0230](0230-check-only-incident-fixes-auto-merge.md) (one more refusal).

## Context
A review of the factory found that nothing protects the tests from the build agent. The agent that
writes the code can delete a test, add `.skip`, add a `@ts-ignore`, lower a coverage threshold or
edit CI, and the only thing that might notice is the reviewer agent, which reads the same diff and
may agree with it. CI on the head then passes because the bar was lowered.

## Decision
- **Detection is code, from GitHub's diff.** A pure module (`packages/core/src/verify/tests-intact.ts`)
  reads the compare of the default branch with the head SHA, with each file's patch, and returns
  findings: deleted tests, removed test cases, skipped / focused / todo tests, commented-out cases,
  new lint and type suppressions (`biome-ignore`, `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck`,
  `eslint-disable`, `as any`), lowered thresholds, and edits to gate files (`.factory/`, CI
  workflows, test and lint config). A test or gate file whose patch GitHub didn't return is itself
  a finding: unknown is never read as intact.
- **A finding is never judged by an agent.** The findings are a section of the review packet for
  that head SHA (**Tests intact**), not part of the reviewer's prompt or report, and no agent can
  clear them.
- **A finding goes to a person, never fails silently.** It doesn't fail the verdict (that would send
  the item back to the same build agent, which might hide the change better); the item goes on to
  the merge gate, which is always a person, and the packet and `factory/verify`'s summary show the
  findings first. `pr.autoMerge` refuses any head whose packet has a finding, so the check-only
  auto-merge class (ADR 0230) can't take them.
- **Unknown is never intact.** A compare with no files, or one that reaches GitHub's 300-file limit
  (files past it weren't checked), is a finding; so is any code, test or gate file whose patch
  GitHub didn't return. A pure rename between two test paths the run still picks up is clean; a
  test moved under a parked path (`disabled/`, `spikes/`, `fixtures/`, …) is a finding.
- **Gate changes include the indirect ones**: the `test`/`lint`/`typecheck`/`check` scripts or a
  test-runner key in `package.json`, `include`/`exclude` in a `tsconfig`, `.github/actions/`, any
  `vitest*`/`jest*`/`playwright*` config file, `.eslintignore`.
- **Findings belong to one SHA.** They live on that SHA's packet; a new head has none until verify
  records its own, so a push can neither carry stale findings nor clear them without verify running.
  The merge queue's carried packet (ADR 0330) keeps them: its diff is unchanged.

## What "no findings" does not mean
The guard reads the diff's shape. It does not see a test weakened from inside while keeping its
shape: `expect(true)`, an assertion deleted from a body that stays, an emptied body, `if (false)`,
a mock that makes the code under test irrelevant. The packet says "No findings" and what was
checked, never "the tests are intact", and the reviewer and the person still read the diff.

## Consequences
- Legitimate changes (a workflow edit the work item is about, a test deliberately removed with the
  feature) are flagged too. That is the point: a person says yes.
- The compare now asks GitHub for patches. GitHub omits a patch for large or binary files; those
  are reported as unreadable when they are tests or gate files.
- The patterns are heuristics for the languages the factory builds now (TypeScript, JavaScript,
  some Python). They only add findings; missing a pattern is no worse than before.
- Findings are kept up to 100 per packet, with the total; titles of removed cases are matched only
  within their own file, so a test moved to another file is a finding a person clears.

# Spec 51: Verify decides from evidence the factory produced itself

Read first: ADRs [0500](../adr/0500-the-factory-guards-the-tests.md),
[0501](../adr/0501-the-factory-runs-the-checks-and-only-executed-evidence-proves-a-criterion.md),
[0020](../adr/0020-verification-and-review-packet.md),
[0037](../adr/0037-factory-verify-pinned-and-sha-bound.md),
[0230](../adr/0230-check-only-incident-fixes-auto-merge.md),
[0231](../adr/0231-verify-verdict-and-the-github-connector.md); specs [04](04-verify-and-pr.md),
[25](25-verify-drift-check.md), [09](09-factory-config-in-the-app.md) (M2, workflows).

## Goal
Verify today is one reviewer run that reports, in its own words, whether the checks and the
acceptance criteria passed, and nothing stops the build agent from weakening the tests it is judged
by. After this spec the verdict rests on what the factory saw itself: the diff on GitHub, the
commands it ran on the head SHA, and CI. The reviewer's opinion stays, labelled as opinion.

## Scope

### PR A: guard the tests (engine and core only)
- A pure detection module (`packages/core/src/verify/tests-intact.ts`) reads GitHub's compare of
  the default branch with the head SHA, with each file's patch, and finds:
  - **deleted tests**: a test file removed, or renamed to a non-test path;
  - **removed tests**: an `it(` / `test(` / `describe(` case removed from a test file whose title
    isn't added back anywhere in the diff;
  - **skipped or focused tests**: added `.skip`, `.only`, `.todo`, `.fixme`, `.skipIf`/`.runIf`,
    `xit` / `xdescribe` / `xtest`, `@pytest.mark.skip`, `@unittest.skip`;
  - **commented-out tests**: an added comment line that is a test case;
  - **new suppressions**: added `biome-ignore`, `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck`,
    `eslint-disable`, `# type: ignore`, `# noqa`, `as any` / `<any>` casts, and `tsconfig` strictness
    flags turned off;
  - **lowered thresholds**: a coverage or threshold number (`lines`, `branches`, `functions`,
    `statements`, `threshold*`, `coverage*`, `min*`) replaced by a smaller one;
  - **gate files**: any change under `.factory/`, `.github/workflows/`, or to test or lint config
    (`vitest.config.*`, `vitest.workspace.*`, `jest.config.*`, `playwright.config.*`, `biome.json`,
    `eslint` config, `.c8rc`, `.nycrc`, `pytest.ini`, `turbo.json`);
  - **unreadable**: a test or gate file whose patch GitHub didn't return (too large, binary).
- `reviewPacket.record` runs it on the compare it already reads, and stores the result on the
  packet for that head SHA as its own section, **Tests intact** (`sections.testsIntact`:
  `{ headSha, intact, findings[] }`). A packet is per SHA, so a new head has no findings until its
  own packet is recorded: they lapse when the head moves.
- Findings never fail the verdict and never reach the reviewer agent: the item still goes to the
  merge gate, a person, who sees them first. `factory/verify` stays as the verdict says (so the
  person can still merge) and lists the findings under "A person must look at".
- `pr.autoMerge` (ADR 0230) refuses when the packet for the head SHA has any finding, so a
  check-only incident fix that weakens a test always goes to a person.
- The app's review packet shows a **Tests intact** section: "Intact" or each finding with its file,
  line and the line's text.

### PR B: run the checks in code, and show what is proven
- **Declared checks.** The project's config gains `checks` (`[{ name, run, timeoutMinutes }]`, at
  most 10), and a workflow may add its own `checks`. Removing or changing a check loosens the
  config (self-modify, a person).
- **The runner host runs them.** A build or verify job carries the item's checks (`job.checks`).
  After the build session's turn ends, the host commits what the session left, then runs each
  check on a **clean copy of the commit** (no ignored files, no git dir) **through the runner
  adapter's `exec`** (a container runner runs them in a check container), else under the host's OS
  sandbox with the harness's floor; with neither, each check is reported not run (ADR 0501,
  amended 2026-11-12). The project declares its install as a check. Each
  result is `{ name, command, exitCode, durationMs, logTail, headSha }` (log tail ≤ 8 KB).
- **A failure goes back to the same session.** When a check fails and the adapter can steer, the
  host types the failure (command, exit code, log tail) into the same build session, waits for that
  turn to end, and runs the checks again: at most `retryLimit` rounds. Then it pushes and hands
  back with the results as they stand.
- **Reported through the runner channel**, on the hand-back (`checks`), and stored by
  `run.handBack` in `core_check_results` against the work item and head SHA (migration 0270).
  A new head has no results until checks run on it.
- **The Workflow (v8; v7 is spec 50 part C's)** reads the build's results for the pushed head: all passed → verify; any
  failed after the session's fixes → a question to a person (try another build, or stop), never a
  cold retry. For an attached PR, the verify job runs the checks before its review session.
- **The verdict** (`reviewPacket.record`) uses the executed results for the head SHA, never the
  agent's report of checks: every declared check must have a passing result on the SHA, and CI must
  be green. A project with no declared checks is a warning in the packet.
- **Proven criteria.** The reviewer maps each criterion to check names (`checks: [...]`, executed
  check names or CI check run names), or the approved spec does (`[checks: …]` on a criterion), which wins. A
  criterion is **Proven** only when a linked executed check passed on the head SHA (not a static
  check like lint or typecheck; a CI check run only when the spec names it), marked weakened when
  the tests-intact guard found gate-file edits; otherwise **Not proven**, with the reviewer's reasoning
  shown as opinion. The reviewer can't mark a criterion proven on its own say-so. A criterion the
  reviewer judges unmet still fails the verdict.
- **`factory/verify`** reflects the executed results: its summary lists each check's result and
  the proven count, and it fails when a declared check failed or didn't run on the SHA.
- **The app's review packet** shows a **Checks run by the factory** section (each check, exit code,
  duration, log tail) and the Proven / Not proven mark on each criterion.

## Out of scope
Headless / stream-json sessions (the hosts plan), a browser-driven behavioural check, the deploy
step, holdout tests (ADR 0034), apps/desktop's screens until PR #56 merges.

## Acceptance criteria
### PR A
1. A diff that deletes a test file, removes a test case, adds `.skip`/`.only`/`xit`/`it.todo`,
   comments out a case, adds a `biome-ignore`/`@ts-ignore`/`@ts-expect-error`/`eslint-disable`/
   `as any`, lowers a coverage threshold, or edits `.factory/`, a CI workflow or test config gives a
   finding naming the file (and line where there is one); a diff that only adds tests gives none.
2. The findings are on the review packet for that head SHA, in the Tests intact section, and are
   not in the reviewer's prompt or report.
3. A packet with findings and green CI still passes its verdict and goes to the merge gate; its
   `factory/verify` summary lists them.
4. `pr.autoMerge` refuses an incident fix whose packet has a finding.
5. A new head SHA has no findings until its own packet is recorded.
6. The app's review packet shows the section, with each finding.

### PR B
7. With `checks` declared, the runner host runs them in the job's worktree on the head it pushes,
   through the adapter's `exec` when the adapter has one, and the hand-back carries exit code,
   duration and log tail per check.
8. A failing check is typed into the same build session with its command, exit code and log tail;
   the session's fix is checked again, up to `retryLimit` rounds; then the item asks a person.
9. The results are stored against the head SHA; a new head has none.
10. The verdict fails when a declared check failed or didn't run on the head SHA, even if the
    reviewer's report says every check passed.
11. A criterion is Proven only with a linked check that passed on the SHA; the reviewer's `met`
    alone leaves it Not proven, with its evidence shown as opinion.
12. `factory/verify` on the head SHA lists the executed results.
13. The app shows the Checks run by the factory section and the Proven marks.

## As built
- **PR A** (#63): as specified. "Forces the item to a person" is the merge gate (always a person by
  the floor) with the findings shown first; findings never fail the verdict, and `pr.autoMerge`
  refuses a packet without `testsIntact.intact === true`. A new file under `.factory/checks/` is not
  a gate-file edit (it is what ADR 0230's check-only class adds).
- **PR B**:
  - Checks are declared in config (`checks`, and a workflow's `checks`); the Settings screens don't
    edit them yet (import or the config JSON does). No project declares any by default, so until one
    does, the packet warns that only CI backs the verdict.
  - The host sends a failure back by `steer` and a second `events()` call: runner-local needed two
    lines (a steer starts a turn). An adapter without `steer` hands back at once and the item asks
    a person.
  - Without `exec` (runner-local today), checks run as a local process with a scrubbed environment
    but **outside the harness sandbox**: the project's own test code runs as the host user. A
    containerised runner should implement `exec`.
  - Not proven doesn't fail the verdict; an unmet criterion still does.
  - A factory item's verify job doesn't re-run the checks: the build's results are on the same SHA
    (`branch.advance` only fast-forwards). An attached PR's verify job runs them once.

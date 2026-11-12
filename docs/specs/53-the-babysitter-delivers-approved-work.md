# Spec 53: The babysitter delivers approved work

Read first: ADRs [0580](../adr/0580-approval-and-delivery-are-separate.md) to
[0585](../adr/0585-one-babysitter-per-repository.md), [0330](../adr/0330-the-factory-runs-its-own-merge-queue.md)
(the merge queue, which this replaces in part), [0037](../adr/0037-factory-verify-pinned-and-sha-bound.md),
[0020](../adr/0020-verification-and-review-packet.md), [0021](../adr/0021-governed-local-sessions.md),
[0320](../adr/0320-factory-branches-stay-mergeable.md), [0511](../adr/0511-a-reconciler-runs-the-stage-list.md),
ADR 0515 (dark factory mode, PR #98); specs [06](06-merge-queue.md), [50](50-projects-backlog-and-release.md),
[51](51-verify-from-the-factorys-own-evidence.md), [52](52-workflows-from-stage-types.md) and
[43](43-runners-under-load.md).

## Goal
The owner: "once a merge is approved a babysitter merges it." Today approving the merge gate makes
the item's own Workflow land its PR through the merge queue, and nothing in the factory watches
`main` after that. After this spec **an approval only says "this head may merge"**. Whoever gave it
(a person, or the workflow's `autoApprove` setting from ADR 0515), the **babysitter** owns
everything from there to Done: the merge, `main` staying green, and later the deploy.

It is modelled on the owner's patientos babysitter, without its cloud routine or any schedule
outside the factory. The factory already has what patientos built around the routine: a webhook
that receives GitHub's events, leases, a queue and runners. So the babysitter has two halves:

- **The deliverer** is engine code with no model in it. Events the engine already receives (an
  approval, a push, a check result, `main`'s CI, a refused merge) wake a pure reconcile pass per
  repository (spec 52's reconciler pattern), which snapshots `main` and every approved PR, orders
  them, updates the head, merges it with the head pinned, stops the line when `main` is red and marks
  the item Done once its merge is on `main`.
- **The `babysit` job** is a factory job of a new built-in kind, claimed by a runner like any other,
  with the per-job repo token and nothing standing. The deliverer starts one only when it meets
  something it can't decide: a conflict with `main`, a check that failed after approval (flake or
  regression?), a red `main` to attribute and repair. It ends when nothing it was started for is
  left. There is no polling loop: no job runs while nothing needs judgement.

## Words
- **Babysitter**: the deliverer plus the `babysit` job, for one repository. Not a person, not a
  routine.
- **Deliverer**: the engine's per-repository reconcile pass (`apps/engine/src/deliver/`).
- **Delivery**: a work item's life after its approval: waiting to merge, merging, held, merged,
  (later) deployed. A row in `core_merge_queue`, which becomes the delivery table.
- **Approval** (of a merge): the decided `merge` pending action, bound to the head SHA and the
  **change digest** it approved (below). It is consumed by the merge.
- **Change digest**: a hash of the PR's change against its merge base: for each changed file, its
  path and the patch with line numbers stripped, from GitHub's compare. Merging `main` in without
  conflicts leaves it unchanged; any other commit changes it.
- **Main health**: `green`, `red` or `pending` for a repository's default branch head, from the
  required checks (the ruleset's, else `ci`) on that SHA.
- **Red episode**: from the first red head after a green one to the next green head. It has an id,
  a start time, the last green SHA, the failing checks and its **suspects** (every landing between the
  last green SHA and the first red one).
- **Held**: an approved delivery that may not merge because `main` is red and it is not a repair.
- **Repair**: a work item whose merge is meant to make `main` green: a **fix** the babysit job
  wrote, or a **revert** of a landing. Only repairs merge during a red episode.
- **Known flake**: a check, or a test inside one, recorded in `core_flakes` after a rerun of it
  passed on the same SHA.

## What main has today (what changes)
- Workflow v4+ (`runV1`, `mergeV4`, `landV4` in `apps/engine/src/workflow/work-item.ts`): the
  merge gate opens `pr.merge` with `apply: false`; once approved, the **item's own Workflow** enters
  the queue (`mergeQueue.enter`), waits for its turn (`mergeQueue.position`, the `mergeq-<item>`
  event), updates the head (`mergeQueue.update`, GitHub's update-branch), waits for CI on the new
  head, and lands with `pr.merge` and the approval id. A conflict or red CI after the update leaves
  the queue and goes back to build.
- `main`'s own CI arrives as a `check_suite` webhook and goes to `verify.refresh`, which finds no
  work item for that SHA and does nothing. A `push` to `main` goes to `push.observe`. Nothing
  records whether `main` is green.
- Nothing reruns a flaky check, and nothing notices a red `main` or reverts anything.

## Scope

### 1. Approval is separate from delivery (ADR 0580)
- **Workflow v11** (the number is provisional: see **Workflow versions** below). After the merge gate is
  approved, the item's Workflow calls `delivery.enter` (today's `mergeQueue.enter`, renamed with an
  alias kept) and waits for one event, `delivered-<item>`, whose payload is the outcome: `merged`
  (with the merge SHA), `conflict`, `failed` (with the reason) or `withdrawn` (the approval no longer
  holds, with what changed). It then finishes the item, or goes back to build or the merge gate as
  today. It never updates or merges anything itself. A hold-timeout re-reads `delivery.position`, so
  a lost event costs time, not the item.
- **Workflow versions.** A running instance replays on the code it started with, so a feature
  must never switch on inside an instance of an older version. No `version >= N` comparisons for
  features: one table in the Workflow (`WORKFLOW_FEATURES`) maps each version number to the set of
  features it has, a row per version, immutable once merged, and code asks
  `has(version, "feature")`. v1 to v7's rows reproduce today's behaviour exactly (the existing
  version tests prove it). A PR takes the next number above whatever is on `main` **at merge
  time** and adds its row; rows of other open PRs do not exist until they merge. This spec's PRs
  say v11 today (`#73`, planning and spec 52's build had claimed v8 to v10); whichever merges first
  renumbers to the next free number then. Each of (b) and (c) that changes the Workflow's steps adds
  its own row rather than folding into v11's after v11 has merged.
- **The deliverer** does what `landV4` did, per repository instead of per item: pick the head, bring
  it up to date, wait for CI on the new head, merge it with `pr.merge` at the head SHA it recorded
  and the approval id, and send `delivered-<item>`.
  - It calls operations through `invoke()` as `{ type: "agent", id: "babysitter" }` (the
    `BABYSITTER` actor), like the pull and the improver call them as theirs. It is code, not a model;
    the actor type is the item Workflow's (`agent`, the foreman), so an approval's checks hold
    unchanged: `pr.merge` is still `ALWAYS_REVIEW` and runs only with an approved pending action for
    that operation, actor type and work item, used once. Nothing changes in the gate.
  - **Triggers** (all already received): the outbox, for `delivery.enter`, `delivery.leave`,
    `verify.refresh` with a PR head or `main`'s head, `push.observe` on the default branch, a
    decided `merge` pending action and the end of a `babysit` job; and the minute cron, for
    repositories whose `next_check_at` has passed. It re-reads GitHub on the cron, which heals a lost
    webhook.
  - **One pass per repository at a time**: a compare-and-set on `core_delivery_state.rev`
    (migration 0350), as ADR 0511 does per item. The key is the repository (an item with no
    repository is never the babysitter's), and `rev` is a fencing token: every operation the pass
    calls carries it and is refused once another pass took over (ADR 0586).
  - **Bounded re-updates.** Each pass brings the head up to date again (a `main` that moved while CI
    ran gets one more update and CI run), at most three update-branch requests per entry
    (`mergeQueue.update`'s `maxUpdates`); past that the item goes back as `failed`.
  - **A merge GitHub refuses is re-snapshotted**, never retried as is and not sent straight back to
    build: the pass brings the head up to date again (a moved `main` updates it and CI runs there);
    a refusal with nothing changed goes back as `failed` (PR (d) asks a person instead).
  - **Only an open item merges.** `pr.merge` refuses an item that is no longer open, and for the
    babysitter an entry no longer open in its queue, read before GitHub is asked and guarded in
    the same batch. Cancelling an item withdraws its approved, unused actions too, not only its
    pending ones.
- **Merge method and order (decision 4):** merge commits only (`method: "merge"`), one PR at a time
  per repository, in approval order, each updated to the current default branch and CI'd once before
  it lands. The engine's own ordering stays; GitHub's merge queue is not used (ADR 0580 §4).
- **Attached PRs** are delivered the same way. The factory still never pushes to their branch: a
  conflict on one goes back to its author through the item, not to a `babysit` job.

### 2. Stop the line on a red main (ADR 0581)
- **Main health** is recorded per repository in `core_main_health` (migration 0351): the head SHA,
  `green | red | pending`, the required checks' conclusions, the last green SHA and the open red
  episode. `verify.refresh` already receives `main`'s `check_suite`; a new operation
  `main.observe` (risk `write`, actor the `github` intake and the deliverer) records it. The required
  checks are the ruleset's required status checks (ADR 0280's generated file names them), else `ci`.
  A check that is `cancelled` or `timed_out` counts as red; a run superseded before it started does
  not count at all.
- **While `main` is red**:
  - only repairs merge. Every other approved delivery is **held**: its card reads "Held: main is
    red", with the episode's start time and failing checks;
  - an item's own verify still runs, and its merge gate can still be approved: holding is about
    landing, not about work;
  - a held delivery isn't brought up to date either: merging a red `main` in would fail its CI and
    send good work back to build. One already updated and waiting for CI when `main` turns red
    finishes its CI and is held before the merge;
  - repairs land first: a repair goes ahead of everything else in its queue. Until the `babysit` job
    opens repairs itself (§4), a person marks one with `workItem.markRepair` (an approver's call).
- **Who is told, and where** (decision 3):
  - **Inbox**: one card per red episode for the project's approvers, "`main` is red on <repo>", with
    the failing checks, the suspects, what the babysitter is doing (rerunning, attributing, a fix or
    a revert open), and the held items. It updates in place and closes itself when `main` is green.
  - **The board**: each held card shows the badge, and the Factory Overview's Babysitter line says
    "main red since 14:02 · 2 held · fixing (#41)".
  - **The phone** (spec 60, once push lands): a push to the project's approvers when an episode
    starts, when a revert needs a person (§5), and when `main` is green again. Nothing per held item.
- `main` turning green releases every hold on the next pass, in approval order.
- **As built (PR b):** `core_main_health` (migration 0351) is per repository, and the episode is its
  `red_since`/`first_red_sha` (a separate episodes table with suspects comes with §5). Health counts
  every check on the head except the factory's own, as verify's CI read does; narrowing it to the
  ruleset's required checks waits for per-repository protection (spec 50). The Inbox card is
  `inbox.list`'s `mainRed`; the phone push is a `notify` (`main.red`, `main.green`) that spec 60 can
  deliver.
- **Review fixes (PR b):**
  - **Reconciled from GitHub.** A held queue's recheck (every 30 minutes, `HELD_RECHECK_MS`, or on
    any wake) calls `main.observe` before it holds anything, so one missed green webhook costs at
    most one recheck. Cost: per repository with held work, one recheck per 30 minutes: three GitHub
    reads (the branch ref, the head commit's time, its check runs), two D1 point reads, and a D1
    write and audit row only when the state changed.
  - **Ordered by GitHub's own times.** An observation's place is the head commit's committer date,
    then the latest start or completion among its counted check runs (`head_at`, `event_at`).
    `main.observe` writes only an observation newer than the stored one, checked when it reads and
    guarded in SQL in its batch, so a push and a check suite read together, or a run on an older
    commit read late, never put an older state back. A rerun in flight is `pending` and keeps the
    episode open; a run cancelled or timed out after it started is red; one cancelled before it
    started (or GitHub's `stale`) doesn't count. Flapping opens one episode per red spell.
  - **Only changes are written.** An observation that changes nothing (the same head, state,
    failing checks and episode) writes nothing, not even an audit row (`quietWhenUnchanged`).
  - **`workItem.markRepair`** is refused unless the line is stopped on the item's repository
    (guarded in its batch). It is browser-only: a person in sf-app, or on the desktop or phone with a
    presence proof for that call (like a merge decision); never the CLI, MCP, a runner or an agent.
    Risk stays `write`: the classes above it would make a person's own mark open a gate for another
    person; the presence proof is the confirmation. A repair sorts first **only while** its
    repository is red; after green it is an ordinary item in approval order.
  - **Items landing through their own Workflow (v4 to v7) are never held**: they started before the
    babysitter and land as they always did until they drain. Only the babysitter's deliveries hold.
  - **Who is told (owner question 4, recommended, not yet answered):** the project's approvers,
    fixed when the episode opens (`core_main_health.audience`, one function: `mainRedAudience`).
    The Inbox card and the `main.red`/`main.green` pushes go to them only.

### 3. An approval survives a clean merge of main (ADR 0582, decision 1)
ADR 0330 already carries an approval over GitHub's update-branch when the new head's first parent is
the approved head and its second parent is on the default branch. This keeps that and adds what the
approval is actually about: the change.
- **It survives when all hold** on the new head:
  1. it is a clean merge of the default branch into the approved head (ADR 0330's parent rule);
  2. the change digest is the same as the approved one (the PR's diff against `main` before and
     after, compared by the engine from GitHub's compare, never from a runner's report);
  3. CI is green on the new head, and, once spec 51's PR B is in, the checks that proved each
     acceptance criterion pass again there (a `checks` job on the new head, no reviewer run);
  4. with `autoApprove` on (ADR 0515), `autoApproveVerdict()` holds again on the new head. All five
     conditions are re-checked; the adjudicator's approval is re-asked only if its inputs changed.
- **It is withdrawn** by any other new commit: a conflict resolved by a `babysit` job, a fix it
  pushed, or a push by anyone. The item goes back to its merge gate. For a resolution, the review
  packet shows **only the resolution**: the files and hunks where the resolved merge differs from
  a plain merge of the two sides, plus the checks on the new head. A person approves that, or,
  with `autoApprove` on, the five conditions decide it as for any head.
- The review packet is copied to a surviving head with `carriedFrom` (ADR 0330), now also recording
  the change digest it was checked against.

### 4. The `babysit` job (ADR 0583, decision 2)
- **A new built-in job kind** `babysit` (runner contract `JOB_STAGES`, harness prompt in
  `packages/core/src/babysit/`). It is claimed from the **light** pool, in the repository, with
  the per-job repo token scoped to that repository, and nothing else. At most one `babysit` job per
  repository is open at a time (§6). It runs as an agent with the role `babysit` (code asks for a
  role, never a model, ADR 0018).
- **What starts one** (the deliverer, never a schedule): a `wake` with one or more reasons, each a
  fact the deliverer recorded:
  - `conflict`: the head conflicts with the default branch and is a factory item (not attached);
  - `check-failed`: a required check failed on an approved head after an update, or on a repair;
  - `main-red`: a red episode started, or a red episode has no repair after 30 minutes.
  Reasons that arrive while a job runs are queued on it (`babysit.next` returns them); the job ends
  when `babysit.next` says nothing is left. A release refused because work arrived means another
  turn, as patientos's lease release does.
- **What it may do without a person**, each an operation with its own floor in code:
  - **rerun a failed check once as a flake** (`ci.rerun`): once per check per SHA, refused a second
    time in code. If the rerun passes, `flake.record` adds the check (and the test, when the job
    names one from the log) to `core_flakes` with the run link, so "known flake" means something
    next time. A flake seen three times in 14 days opens a backlog item to fix it (never released by
    itself).
  - **resolve a conflict** by merging the default branch into the branch on a run branch
    (`factory/<id>-<slug>-babysit-<n>`), never a rebase or force push; the engine moves the item's
    branch to it (`branch.advance`, ADR 0052). That withdraws the approval (§3). A conflict in a
    generated file is resolved by rerunning its generator; a migration-number clash goes to a
    person.
  - **open a fix** as a repair: a work item of kind `repair` whose branch the job pushed. It skips
    triage, spec and build, and goes through verify, the merge gate (or `autoApprove`) and delivery
    like anything else, ahead of held items. The job never pushes to the default branch.
  - **ask for a revert** (§5).
  - **send an item back to build** with the failure, when a check failure on its head is a
    regression and not a flake.
- **What it never does**: push to the default branch, merge, approve, change settings, rulesets or
  config, deploy or roll back, close a PR, or force-push. Its job token can't do most of these;
  branch confinement (ADR 0052) refuses the rest.

### 5. Red main: attribution, fix or revert (ADR 0584)
- **Claim**: a red episode has at most one `babysit` job working it (the job's reason). A second
  never starts.
- **Flake or regression?** The job reads the failed run's log (failed steps only), and decides:
  infrastructure (connection resets, a cancelled job at its limit, OOM, a provider API error), a
  check or test in `core_flakes`, or a test that passed on another run over the same code is a
  flake: rerun once (§4). Otherwise a regression.
- **Attribution**: the suspects are the episode's landings, in order. The job matches the failing
  checks and tests to the suspects' changed files and says which and why
  (`mainRed.attribute`, recorded on the episode). If it can't narrow it, it says that, and keeps the
  episode open for a person. **Never revert a guess.**
- **Is someone on it?** An open repair for the episode, or anything merged since the failing head,
  means wait for it, not write a second.
- **Repair**: a small, clear fix becomes a `repair` item (§4). Otherwise, once the episode is 30
  minutes old with the culprit identified and no fix under way, a **revert**.
- **The revert is made by the engine, not the agent**: `mainRed.revert` asks GitHub to revert the
  culprit's PR (the merge commit, `-m 1`), which opens a PR with exactly the inverse change and no
  agent-written code, titled `Revert "<original title>"`. It is a `repair` item.
- **It merges on its own approval only when the workflow says so** (decision 2): the Deliver
  stage's `revertWithoutPerson` setting, off by default; turning it on is a loosening only a person
  makes (ADR 0370, 0515 §2). The `auto-approve` actor (ADR 0515) decides the revert's merge gate
  only when, in code (`revertVerdict()`):
  1. the setting is on;
  2. the PR is the engine's revert of a landing in the open episode's suspects, unchanged (its
     change digest is the inverse of the culprit's);
  3. the episode is at least 30 minutes old and no other repair for it is open or merged;
  4. CI on the revert's head is green on every check that is red on `main`'s head, which proves the
     revert repairs `main` rather than trusting the attribution.
  Otherwise the revert's merge gate goes to a person like any merge, and the phone is told.
- **After a revert**: a comment on the original PR with the failure and what to reland, and a new
  backlog item "Reland: <title>" linked to the original (not released). A revert of an auto-approved
  merge sets the project's `autoApproveHold` (ADR 0515 §7).

### 6. The babysitter fails safe (ADR 0585, decision 7)
- **One per repository.** `core_delivery_state` (migration 0350) has one row per repository: `rev`
  for the deliverer's compare-and-set, and the open `babysit` job id with a **delivery fence**, a
  number that only increases with each `babysit` job. Every write a `babysit` job makes
  (`ci.rerun`, `flake.record`, `mainRed.*`, `branch.advance` of a resolution, a `repair` item) carries
  its fence and is refused when stale (ADR 0035's rule, per repository).
- **A job that dies** (lease expired, runner gone, ADR 0550's reaper): the job fails as any job does;
  the deliverer sees its reasons still open on the next pass and starts a fresh job with a new fence
  and a note of what the last one recorded (its run branch, if it pushed). A pushed but unadvanced
  resolution is offered to the next job, never advanced blindly.
- **GitHub refuses a merge** (405, 409, "head moved", "not mergeable"): the snapshot is stale. The
  deliverer records the refusal, takes a new snapshot of the head and `main`, and decides again; it
  never retries the same merge. Three refusals in a row for the same head with nothing changed in the
  snapshot ask a person (an Inbox card on the item), and the next item may go.
- **A pass that throws** leaves `rev` unchanged; the cron's next pass starts from the snapshot again.
  Every action is idempotent by key (`<repo>:<delivery>:<action>:<head>`), like the reconciler's.
- **Someone merges on GitHub** outside the babysitter: the head behind it updates as ADR 0330 says;
  a push to the default branch that wasn't the babysitter's is a landing like any other, and a suspect
  if `main` goes red.

### 7. Fit with spec 52 (decision 6)
- **Deliver is a built-in stage type** (`deliver`), the last delivery stage of every workflow whose
  `publish` stage merges into a repository. `validateWorkflow` adds a rule: such a `publish` stage is
  followed by exactly one `deliver` stage, which can't be removed or moved. The Software, Incident and
  Attached PR built-ins end with it.
- Its settings are **tighten-only**, like the other built-ins: `flakeReruns` (1, may be lowered to
  0), `revertAfterMinutes` (30, may be raised), `revertWithoutPerson` (off; on is a loosening and a
  `self-modify` save), `holdOnRedMain` (always on, not a setting a workflow can turn off).
- `publish` keeps the decision (the merge gate, `autoApprove`); `deliver` owns landing. The merge
  queue's carry-over moves out of `publish`'s merge code into `deliver` (spec 52 ADR 0512's "one
  defined exception").
- **Done**: an item is Done when its merge commit is on the default branch (the merge response,
  confirmed by the next `push` to it). `main` going red after it doesn't undo Done: the item becomes
  a suspect, and a revert opens a reland item. Once a deploy stage exists, Done waits for the deploy
  (§8).
- Under spec 52's reconciler the Deliver stage's `next()` reads the delivery row and waits; until
  then Workflow v11 waits on `delivered-<item>`.

### 8. Deploys (out of scope until the deploy step exists)
The babysitter will then own following each merge to its deploy: it records which merge each deploy
shipped, shows "deployed" on the card, reruns an infrastructure failure of a deploy once (the same
rule as a flake), and tells a person about anything else. It never deploys on its own, never
approves a deployment and never rolls back: those stay a person's, or `autoApprove`'s once a deploy
stage with a health check exists (ADR 0515 §6).

### 9. Where it shows (decision 5; the desktop app's screens are built by its own workers)
What the screens need, and the operations that serve them:
- **Factory > Overview, a Babysitter line per repository**: main green or red (since when, failing
  checks), what it's doing ("merging #41", "waiting for CI on #41", "resolving a conflict on #43",
  "rerunning ci on 3f2a1c0", "idle"), what's held. **`delivery.status`** (read, per project): for
  each repository, main health, the open red episode, the open `babysit` job and its reasons, and the
  deliveries in order with their state.
- **Each item's Activity**: the deliverer's and the job's actions as audit events (already journaled
  by `invoke()`): entered delivery, updated to `main` at <sha>, CI green, held, merged as <sha>,
  approval carried over / withdrawn and why, rerun as a flake, resolved a conflict.
- **The card**: `approved, waiting to merge (2nd)` versus `merging` versus `held: main is red`
  versus `merged` (versus `deployed` later). **`delivery.position`** (today's `mergeQueue.position`
  plus `state` and `heldBy`) and a `delivery` field on `workItem.get`.
- **The Inbox**: the red-episode card (§2), a revert waiting for a person (§5), a merge GitHub
  refused three times (§6), and a resolution to review (§3) as an ordinary merge card that shows only
  the resolution.

## Out of scope
- Deploys (§8). Batching several PRs into one CI run. GitHub's merge queue as a backend.
- Desktop and web UI: the screens above are built by the desktop app's workers from the listed
  operations.
- Contributor review, Slack threads, Linear and session titles (patientos-specific).
- Several repositories per item, and per-repository protection (spec 50's follow-up).

## Build plan
Small PRs, deterministic part first. Block **AP**: migrations 0350–0359 (0350 delivery state,
0351 main health, 0352 the approved change, 0353 `core_flakes`), ADRs 0580–0589. Workflow version
**v11**, provisional: the next free number on `main` at merge time, added as a row of
`WORKFLOW_FEATURES` (see **Workflow versions**).
1. **Docs** (this spec, ADRs 0580–0585, CONTEXT.md). No code.
2. **(a) Approval separated from merge.** Workflow v11; `core_delivery_state` (migration 0350); the
   deliverer in `apps/engine/src/deliver/` doing exactly what `landV4` does (update, CI, merge,
   conflict and red CI back to build), triggered by the outbox and the cron; `delivery.*` aliases of
   `mergeQueue.*`. No behaviour change: v4–v7 instances keep landing themselves; v11 items are landed
   by the deliverer. Tests: spec 06's criteria 1–7 pass with v11 items.
3. **(b) Stop the line.** `core_main_health` (migration 0351), `main.observe`, the held state,
   `delivery.status`, the red-episode Inbox card.
4. **(c) Approval survives a clean merge of main.** The change digest, its check on update, the
   `withdrawn` outcome, the re-check under `autoApprove` (once ADR 0515 is built).
5. **(d) The `babysit` job kind.** `JOB_STAGES`, the prompt, `babysit.next`, `ci.rerun`,
   `flake.record` and `core_flakes` (migration 0353), conflict resolution with `branch.advance`, the
   delivery fence; the `conflict` and `check-failed` reasons.
6. **(e) Red main.** Episodes and suspects, `mainRed.attribute`, `repair` items, `mainRed.revert`,
   `revertVerdict()`, the reland item.

## Acceptance criteria
1. (a) Two v11 items approved in one repository merge in approval order through the deliverer; the
   item's Workflow never calls `mergeQueue.update` or `pr.merge`. Spec 06's criteria 2–7 hold for v11
   items. v4–v7 instances replay unchanged and v11's step names are frozen in
   `workflow-versions.test.ts`.
2. (a) A lost `delivered-<item>` event costs at most the hold timeout: the Workflow re-reads its
   delivery and finishes.
3. (a) Two deliverer passes for one repository at once: one wins the compare-and-set, the other does
   nothing; no action runs twice.
4. (b) A red required check on `main`'s head holds every approved non-repair delivery in that
   repository; a repair still merges; green releases them in order. One Inbox card per episode.
5. (c) A clean update with an unchanged change digest and green CI merges with no second approval.
   A head with any other new commit is `withdrawn` and goes back to the merge gate; the packet shows
   only the resolution.
6. (d) A failed check after approval starts one `babysit` job; a rerun of the same check on the same
   SHA a second time is refused in code; a passing rerun records a known flake.
7. (d) A `babysit` job that dies mid-resolution is replaced by a new job with a higher fence; the
   dead job's late writes are refused.
8. (d) A merge GitHub refuses is never retried as is: the deliverer re-snapshots, and three
   refusals with nothing changed ask a person.
9. (e) A revert merges with no person only when `revertWithoutPerson` is on and `revertVerdict()`'s
   four conditions hold; turning the setting on is a loosening.
10. Nothing in the babysitter pushes to the default branch, and no `babysit` job can merge.

## Questions for the owner (each with a recommendation)
1. **Approval across a merge of `main`.** Recommended: it survives a clean merge whose change digest
   is unchanged and whose checks pass again on the new head (§3); a resolved conflict or any other new
   commit withdraws it and the person sees only the resolution. Alternative: every new head goes back
   to the person.
2. **The one thing it may merge on its own.** Recommended: an engine-made revert of the attributed
   culprit, after 30 minutes red, only when the workflow's Deliver stage has `revertWithoutPerson` on
   (off by default) and the revert's own CI proves it repairs `main` (§5). Alternative: every revert
   goes to a person, with a phone push.
3. **Recording flakes.** Recommended: a known-flake list (`core_flakes`) per repository, and a
   backlog item to fix a check once it flakes three times in 14 days. Alternative: a backlog item for
   every first flake.
4. **Who is told when `main` is red.** Recommended: one Inbox card per red episode for the
   project's approvers, the held badge on the board, the Overview line, and a phone push at the start,
   when a revert needs a person, and at green. Nothing per held item.
5. **Reverted work.** Recommended: a new backlog item "Reland: <title>" linked to the original,
   which stays Done. Alternative: reopen the original item.
6. **When an item is Done.** Recommended: when its merge commit is on the default branch; a red
   `main` after it makes it a suspect, not undone. Alternative: Done only after `main`'s CI on the
   merge is green.
7. **Merges on GitHub while held.** Only the factory merges, but a person can still press merge on
   GitHub while `main` is red. Recommended: `factory/verify` on a non-repair PR's head reads "held:
   main is red" (pending) during an episode, as patientos's `main-health` status does, so GitHub
   refuses those merges too. Alternative: leave GitHub alone and only hold inside the factory.
8. **Attached PRs.** Recommended: delivered by the babysitter like any item, but a conflict goes back
   to their author; the factory never pushes to their branch (ADR 0290).

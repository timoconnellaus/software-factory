# ADR 0591: The audit archive, as built

Status: accepted, 2026-11-13. Block AQ, the Cloudflare cost work. Builds the retention the owner
decided in [ADR 0590](0590-the-audit-journal-records-changes-not-machine-chatter.md) (2026-11-12):
routine machine rows are archived to R2 after 90 days and stay verifiable; decisions, refusals and
approvals stay in D1 forever. Migration 0366.

## Context
ADR 0590 fixed the shape: one object per day of machine rows in `(at, id)` order, a hash chain
computed at archive time, each day's root in D1 and in the object, nothing added to the hot write
path, and a delete trigger that allows only archived machine rows. Building it settled five things
the proposal left open.

## Decision
1. **A machine row is a list of operations, not just a class of actor.** A row may be archived (and
   so deleted) only when it is all of these:
   - written by a runner, the scheduler, an intake connector, or the foreman (`agent`/`foreman`).
     Never a person's row, another agent's or `self-improve`'s;
   - `decision = 'allow'` and `outcome = 'ok'`, with no `pending_action_id` and no `approval_id`;
   - one of 26 routine operations: leases, heartbeats, claims, steers, run events, artifacts,
     hand-backs, stage moves, merge-queue moves short of merging, a branch's first push, news
     deliveries and the intake's observations.

   The list is in migration 0366's trigger and in `AUDIT_ARCHIVE_OPERATIONS`
   (`packages/core/src/audit-chain.ts`), and a test keeps the two equal. These are never on it:
   - merges, PRs, specs, triage, questions, planning content and artifacts;
   - gates, incidents, config and policy changes;
   - items created or released, sign-ins.

   Changing the list is a migration, so it is a policy change a person reviews. Rows with an
   idempotency key are archived too: a key guards a retried call, and retries come within minutes,
   not 90 days.
2. **The archiver finds a day's rows by rowid, not by a new index.** An index on `at` would cost a
   write on every audited call, which ADR 0590 rules out. `rowid` grows with commit order, and a
   row commits within `commitSkewMs` (1 hour, generous) of its `at`. So:
   - for any row z, every row before it has `at` < z.at + skew, and every row after it has `at` >
     z.at − skew;
   - a page reads a bounded rowid window (searched by rowid range), keeps only the rows whose `at`
     the window provably covers, and sorts them to `(at, id)`. The window starts at 5,000 rows and
     doubles while it is too narrow, up to 200,000 for the pre-ADR 0590 backlog;
   - the floor (the largest rowid known to be done) is found by probes: 31 rowid seeks per query
     through `json_each`, four rounds at most, then carried forward from each page's rows.

   `rowid` is never part of the chain or of a record; only `(at, id)` are. A row whose call ran
   longer than the skew is not lost. Deletes name the archived ids, so that row stays in D1 and is
   still shown.
3. **A day is cut into chunks**, one object each, of at most 1,000 rows or 1 MB, named by day, seq
   and `(at, id)` range (`audit/YYYY/MM/DD/<seq>_<first>__<last>.ndjson`) and written create-only.
   - Each line is `{ hash, row }` with `hash = SHA-256(prev ‖ canonical JSON of the row as stored)`.
   - `core_audit_archive_chunks` records each chunk's range, first and last hash. The chunk's
     record, its work-item index rows and the delete of its rows are one D1 batch. The batch records
     only while the tick holds the day's lease, the chain continues from the chunk before (or the
     previous day's root, or genesis), and every row is still there. It deletes only where the
     record names that object.
   - `core_audit_archives` records the day (root, chunks, rows, the root it chains from) once its
     last chunk is in. An empty day is recorded too, so a missing day breaks the link.
   - A tick that died after its put leaves an object, and the next tick uses it only if it is
     byte-for-byte the chunk it would write. Otherwise the tick stops and deletes nothing.
   - The delete trigger checks the class, the age (90 days by the database's own clock) and that a
     chunk record's range covers the row.
4. **The read path: the item timeline.** It is the only screen that shows audit rows; the other
   reader is `invoke`'s idempotency lookup. `core_audit_archive_items (work_item_id, day, seq,
   rows)` says which objects hold an item's rows.
   - `workItem.timeline` reads it in the same D1 request as its entries and reports
     `archive: { rows, chunks, state, more }`.
   - With `archived: true` it reads those objects from R2, at most 20 a call, and merges the item's
     rows in, marked `archived`.
   - The states are #118's: `available`, `read`, `failed` (try again) and `missing` (an object the
     records name is gone).
   - The desktop's Activity tab shows the count and a Show them button. It polls D1 only, and reads
     the archive on demand. The website is becoming sign-in only (ADR 0610), so it is unchanged.
5. **`audit.verify`** (an org admin; also `sf call audit.verify`) re-hashes up to 31 days.
   - Every object is read fresh from R2, past the isolate's cache, at most 100 per call.
   - It checks each line's hash, the order, that each row is a machine row of that day, each
     chunk's record, each day's root, and each day's link to the day before.
   - It reports a verdict per day with why: an altered row, a missing object, a gap, a broken link.
     It never reports rows.
   - The archive holds every org's machine rows, so any org admin may verify the whole chain.

## Cost
- **Hot path: nothing.** No index, no counter, no read before an audited call's batch.
- **Per archived row:** its delete, once, which is 4 rows written (the table, the `id` and
  `idempotency_key` autoindexes, `core_audit_item_idx`).
- **Per chunk:** 2 rows written for its record, 2 per item in it, and 1 for the lease. Per day,
  about 5: the lease, the day's record and the lease's delete.
- **Measured on the test's data** (`apps/engine/test/audit-archive.test.ts`): 9 machine rows over
  10 days, most of them empty, took 89 queries in three ticks, 970 rows read and 71 rows written.
- **Each tick** makes at most 60 D1 queries, and runs every five minutes (minute ≡ 2 mod 5).
- **When the archiver is within 3 days of the cutoff** it archives whatever is due: a few thousand
  rows a day, which is a few chunks.
- **Further behind, it drains the backlog under its own budget** of 5M rows written a month,
  spread over the days left in it. It takes only what keeps live traffic, the run archive and
  itself under the run archive's 40M ceiling, so it yields to busy jobs as #118's drain does.
- **Every statement is in the query-plan guard.** The page's sort is allowed because it sorts one
  rowid window.

## Not done here
- A lost audit object is reported by `audit.verify` and by the timeline's `missing` state. It does
  not open an incident, because there is no run to record it against, as #164 did. If the owner
  wants one, it is a small follow-up.

## Changed in review, 2026-11-13 (#170)
- **What stays in D1, by name.** The list now leaves out everything that issues a credential and
  everything that records what reached main. `NEVER_ARCHIVED` names them, and a test keeps them off
  both lists:
  - the device logins (`runner.deviceStart` and `runner.devicePoll`, `cli.deviceStart` and
    `cli.devicePoll`). Their settled row is the record that a runner key or CLI token was issued;
  - `run.issueToken`, the GitHub job token's mint (ADR 0033);
  - `mergeQueue.merging` and `branch.advance`, which record what reached main.

  The list is 29 operations.
- **The trigger checks a range, not membership.** It refuses a delete unless a chunk's
  `(at, id)` range covers the row. Membership comes from the archiver's batch, which deletes exactly
  the ids it wrote to the object, in the batch that records it. Checking membership in SQL would
  cost 2 to 4 more rows written per archived row.
- **No replace.** `INSERT OR REPLACE` deletes without firing delete triggers, so a person's row could
  have been replaced by a machine row and then archived. `core_audit_no_replace` aborts an insert
  whose id or idempotency key is already there, with a UNIQUE-conflict message, which `invoke()`
  still recognizes. That is two index lookups per audited call. They are reads, with no write, and
  the only addition to the hot path.
- **The records are append-only.** `core_audit_archives`, `core_audit_archive_chunks` and
  `core_audit_archive_items` refuse UPDATE and DELETE, so the chain's head only advances by a new
  day. The new delete trigger is created before the old one is dropped.
- **The timeline:**
  - it pages past 20 objects with `archiveAfter` and `archive.next`;
  - it checks each object against its record's SHA-256, since the isolate may cache it. One that
    doesn't match shows as `missing`, never as what it holds.
- **`audit.verify` gives verdicts only.** Each day comes back with `ok`, a status and why, and no row
  or object counts, so another org's volume isn't shown. The statuses are `before the archive`,
  `not yet`, `missing` (a gap between archived days) and `archived`. A missing chunk record is a
  failure, never read as the call's cap.
- **A stopped archiver is an incident.** After three stopped ticks in a row, the archiver records a
  `core_incidents` row of kind `audit_archive_stopped`:
  - it belongs to the factory, so it has no org, project or work item. `core_incidents` is rebuilt
    in 0366 for that, with a CHECK that every other kind has all three;
  - it shows on the desktop's Checks and incidents page, with no Inbox card;
  - the archiver resolves it itself once a tick archives again.

  Health is kept in `core_meta` (`audit-archive:health`). It also counts machine rows of archived
  days still in D1, which are calls that outran the commit skew, and logs them.
- **The drain's credit** carries over on every drain tick, archived or not.

## Changed in review, round 2, 2026-11-13 (#170)
- **Three security events stay in D1.** They are on `NEVER_ARCHIVED` and off both lists, which now
  name 26 operations:
  - `verify.refresh`: with `closed` or `merged`, it is the only record of a PR merged outside the
    factory and by whom, and it withdraws merge gates;
  - `push.observe`: a branch-confinement violation is stored as `ok`, and a person's push withdraws
    an approval;
  - `mergeQueue.update`: carries the review packet and approval to a new head.
- **No replace anywhere.**
  - `core_audit_no_replace` also refuses an insert whose explicit rowid exists.
  - The three archive tables get the same BEFORE INSERT trigger, by key or by rowid. INSERT OR
    REPLACE and REPLACE are refused on all four tables, with recursive triggers on or off (tested).
- **`audit.verify` carries on within a day.** `after: { day, seq }` resumes from the record of the
  object before, and a day cut by the 100-object cap answers `partial` with `next`. Failures name no
  counts.
- **The drain writes whole objects.** It waits until its carried credit covers a chunk. A page short
  of 1,000 rows (or 1 MB) that isn't the day's end widens its window instead of cutting a small
  object.
- **The archiver's incident goes through an operation.** It is `audit.archiveHealth`, run as the
  scheduler and audited. Only an org admin sees why the archiver stopped.
- **The timeline's totals** count every page, and the D1 entries a call read are never dropped to
  make room for archived ones.

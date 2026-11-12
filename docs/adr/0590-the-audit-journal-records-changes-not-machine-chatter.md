# ADR 0590: The audit journal records changes, not machine chatter

Status: accepted for the journal's writes, 2026-11-12. Retention is **proposed**: the owner decides
(the question is at the end). Block AQ, the Cloudflare cost work
([AGENTS.md, "Cloudflare cost"](../../AGENTS.md#cloudflare-cost), rule 12). Amends ADR 0004, 0011 and 0050 (one
batch, one audit row per call).

## Context
`invoke()` writes one `core_audit` row for every operation that isn't a read. Migration 0020 makes
the table append-only: a trigger refuses UPDATE and DELETE. So every row stays in D1 forever.

Most of those rows come from machines, not decisions:
- a runner's heartbeat and claim every 20 s;
- the held steer call, which takes steers three times per 25 s hold per running job;
- `planning.presence` every 20 s per open Planning tab;
- `run.reportEvents` every 3 s while a run logs, with each event's payload copied into the audit
  row's `input` although `core_run_events` already keeps it.

The `takeSteers` rows also carry the work item, so they flooded `workItem.timeline`.

D1 bills every row written, index entries included, and refuses writes once a database reaches
10 GB (the Workers Paid limit, checked against Cloudflare's D1 limits page on 2026-11-12).

### Measured
`apps/engine/test/audit-volume.test.ts` runs one cycle of each source through the real channel and
operations. It counts D1's `rows_written` and the audit rows and bytes added, with this ADR's
changes switched off (before) and on (after). The figures are scaled to a day at the clients'
intervals:

| Source (interval) | Rows written per day | Audit rows per day | Audit bytes per day |
| --- | --- | --- | --- |
| Idle runner: a heartbeat and a claim (20 s) | 64,800 → 30,240 | 8,640 → 0 | 4 MB → 0 |
| Running job: the steer hold (25 s) | 62,208 → 0 | 10,368 → 0 | 4 MB → 0 |
| Running job: a log batch of 50 lines (3 s) | 3,196,800 → 3,081,600 | 28,800 → 0 | 374 MB → 0 |
| Open Planning tab: presence (20 s) | 21,600 → 4,320 | 4,320 → 0 | 1 MB → 0 |

How to read the table:
- The log batch's rate is an assumption: 50 lines of about 120 bytes every 3 s while the agent
  works. A real run logs in bursts.
- The heartbeat figures already exclude the channel's idempotency rows, which PR 1 removed for the
  heartbeat.
- The 30,240 rows a runner still writes are:
  - the heartbeat's own writes: the runner row and each held job's lease renewal;
  - the claim's channel idempotency entry: an insert and an update, plus the cron's delete later.
- The log batch's remaining 3M rows a day are `core_run_events` itself: one row and one index
  entry per line. That is the next cost to look at (see "Not decided here").

## Decision
1. **Changes-only audit.** An operation can declare `audit: { changesOnly: true, changed?(output) }`.
   Such a call writes its audit row only when it changed state, which means one of these:
   - the handler called `ctx.change` or the new `ctx.changed()`;
   - it queued an outbox message;
   - `changed(output)` returns true.

   Some calls are always audited, as before:
   - refusals and failures;
   - a call with an idempotency key;
   - a call that applies an approval.

   When such a call has nothing to write and nothing to audit, it commits no batch at all. Its fence
   and device guards only protect writes, and each guard costs an insert and a delete.
   - `runner.heartbeat`: audited when it sends a command (a cancel or an account switch).
   - `job.claim`: audited when it hands out a job; an empty claim is not.
   - `run.takeSteers`: audited when it hands steers over. Steers then show on the timeline once
     each, as deliveries.
   - `planning.wait` and `planning.news`: audited when news is handed over. `logPlanning` calls
     `ctx.changed()`, so a session's state change (idle, announced) is audited too.
   - `planning.presence`: audited when someone arrives or leaves (through `logPlanning`).
   - `runner.devicePoll` and `cli.devicePoll`: audited once the login settles.
   - `run.reportEvents`: audited when a batch moves the run: a `job.state`, a `session.started` or
     a `takeover`. Log, status and tool events are kept in `core_run_events`, not copied into the
     audit.
2. **A runner's input is kept as a digest.** For a runner caller, the audit's `input` is
   `{ sha256, bytes }` of the canonical JSON (`inputDigest`, the same digest presence proofs use),
   plus the ids a reader follows: `jobId`, `fencingToken`, `claimId` and `workItemId` when present.
   - The body was a manifest or an event batch, and nothing reads it back. `invoke`'s idempotency
     replay reads `result`, never `input`.
   - Results are unchanged: `workItem.timeline` shows them.
3. **Nothing is deleted in this change.** The append-only triggers stay. How long the journal is
   kept is a policy decision (below).

## Proposal: retention (for the owner)
What the journal is for: who decided what, under which policy, and what it changed. A gate
decision, a refusal or a policy change is evidence. A lease renewal is not.

**Kept in D1 forever:** every row that is any of these:
- a person's or an agent's call (`actor_type` `human` or `agent`);
- a gate's (`decision` other than `allow`, or a `pending_action_id` or `approval_id`);
- a refusal (`outcome` other than `ok`);
- a self-modify or self-improve change.

These are a few hundred rows a day for a small team.

**Archived to R2 after 90 days, then deleted from D1:** the remaining rows. These are runner,
scheduler, foreman and intake calls with `outcome = ok` and `decision = allow`. After this ADR,
that is about 20–40 rows per job (claim, tokens, state changes, artifacts, hand-back, release),
which is an estimate, not a measurement.
- **The archive:** one object per day, `audit/YYYY/MM/DD.ndjson`. Its rows are in `rowid` order,
  each the full row as stored.
- **The record of it:** a new table, `core_audit_archives (day, r2_key, first_rowid, last_rowid,
  rows, sha256, prev_sha256, archived_at)`. It is kept in D1 forever and is one row a day.
  - `sha256` is the object's digest.
  - `prev_sha256` is the previous day's digest, so the archive is a hash chain.
- **How it stays verifiable:** recompute the day's digest from R2 and compare it with D1. A missing,
  altered or reordered day breaks the chain at that day. R2 objects are written once and never
  overwritten. The cron archives and verifies one day per tick, in batches of a few hundred rows.
- **The trigger:** the no-delete trigger is replaced by one that refuses a DELETE unless an
  archive row covers the row's `rowid`, and the row matches the "archived" class above. UPDATE
  stays refused. The table stays append-only for everything kept forever.

**Size against the 10 GB cap.** Rough, per day:

| | Audit rows per day | Audit bytes per day | Years to fill 10 GB (audit alone) |
| --- | --- | --- | --- |
| Before (3 runners, 8 jobs logging, 2 tabs open) | about 25,900 + 8 × 39,168 + 2 × 4,320 ≈ 348,000 | about 12 MB + 8 × 378 MB + 2 MB ≈ 3 GB | under a week |
| After this ADR, kept forever (100 jobs a day × 40 rows + 500 decisions, ~1.5 KB a row) | about 4,500 | about 7 MB | about 4 |
| After, with the proposed 90-day archive (decisions forever, machine rows 90 days) | 500 kept + 4,000 for 90 days | under 1 MB kept, about 540 MB in the window | well over 20 |

How to read the table:
- The "before" row multiplies the measured worst case. The log batch's rate is an assumption, so
  it is an upper bound, not a forecast.
- The "after" rows are estimates from the operations' shapes, not measurements of real use.
- D1 also holds the run events and the other growing tables (PR 3 proposes their retention). The
  audit's share has to leave room for them.

## Not decided here
- **`core_run_events` stores one row per line.** At the assumed log rate, that is about 3M rows
  written a day per logging job: 92M a month, about $42 a month over the included 50M. Storing a
  batch as one row would make it about 2 rows per batch. That changes the live view's reads, so it
  is a separate change, and PR 3 proposes its retention.
- **The claim's channel idempotency entry** (4 rows written per claim, 3 more when pruned).
  `job.claim` is already idempotent by `claimId` (the unique `(runner_id, claim_id)` index), so it
  could be unstored like the heartbeat. That is runner-channel code its owners should agree to.

## The question for the owner
Keep everything in D1 forever, or archive the machine rows (runner, scheduler, foreman and intake
calls that were allowed and succeeded) to R2 after **90 days**, as a hash chain recorded in D1?
Decisions, refusals and gates stay in D1 either way. If you choose to archive: is 90 days right, and
may the no-delete trigger be replaced by one that allows only archived machine rows to be deleted?

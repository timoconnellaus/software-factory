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
| Runner: a heartbeat (holding one job) and an empty claim (20 s) | 125,280 → 12,960 | 8,640 → 0 | 4 MB → 0 |
| Running job: the steer hold (25 s) | 62,208 → 0 | 10,368 → 0 | 4 MB → 0 |
| Running job: a log batch of 50 lines (3 s) | 3,196,800 → 3,081,600 | 28,800 → 0 | 374 MB → 0 |
| Open Planning tab: presence (20 s) | 21,600 → 4,320 | 4,320 → 0 | 1 MB → 0 |

How to read the table:
- The log batch's rate is an assumption: 50 lines of about 120 bytes every 3 s while the agent
  works. A real run logs in bursts.
- The runner row is as it was on `main` before this work, 29 rows a cycle:
  - two audit rows at 6 each (the table, two unique autoindexes, three indexes);
  - the channel's idempotency entry for the heartbeat and for the claim. Each is an insert (3)
    and an update (1), plus the cron's delete a day later (3), so 7 each;
  - the runner row, written by both calls (2), and the held job's lease renewal (1).

  The test measures the audit and the remaining writes directly. The idempotency entries are counted
  from the code, because PR 1 (heartbeat) and this ADR (claim) take both calls out of the store.
- The runner's 12,960 rows a day after are the runner row twice and the lease renewal once per
  cycle. Without a held job, it is 8,640.
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
   - `runner.heartbeat` and `job.claim` (which both report the runner's state): audited when they
     change something a person looks for after an incident. That means:
     - whether the runner takes work: accepting, paused, the rate limit, capacity max;
     - its code: version, auto-update, update state and target, compat;
     - its manifest or accounts;
     - the owner's account pick settling.

     The heartbeat is also audited when it sends a command (a cancel or an account switch).
   - `job.claim`: also audited when it hands out a job (`ctx.change`), or changes why a job waits
     (`wait_reason`), or asks an idle planning session to yield. It is not audited when empty, or
     when a retried `claimId` gets the job it already had.
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
3. **The claim leaves the channel's idempotency store**, as the heartbeat did in PR 1.
   - `job.claim` is idempotent by its `claimId`: a retry gets the job the first call claimed.
   - Two racing retries can't claim two jobs. The unique `(runner_id, claim_id)` index and the
     "job still queued" guard fail the loser's batch, so it answers 409 `conflict`.
   - That saves 7 rows written per claim, every 20 s per runner.
4. **The complete list of writes that are not audited.** A changes-only call that changed none of
   the above still writes these:
   - the runner row's capacity in use, light pool in use and `last_seen_at` (every heartbeat and
     claim), and `last_signed_at`;
   - each held job's lease renewal;
   - `core_runs.last_event_at`, and the run events themselves in `core_run_events`;
   - a planning session's `agent_seen_at`, and the news hand-over and read marks (`planning.news`,
     `planning.wait`: delivered cursors, `delivered_at` on messages and answers);
   - `core_planning_presence.seen_at` for a person still on the page;
   - the device polls' `last polled` state while a login is pending.

   Everything else these operations write is audited.
5. **Nothing is deleted in this change.** The append-only triggers stay. How long the journal is
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
- **Every row gets a sequence and a link.** `core_audit` has a TEXT primary key, so its `rowid` is
  not stable (VACUUM may renumber it), and a gap in it proves nothing. Instead:
  - two columns are assigned at insert, in `invoke()`'s batch: `seq`, an INTEGER from a one-row
    counter that the same batch increments, so it has no gaps; and `prev_hash`, the SHA-256 of the
    previous row's canonical JSON, read in the same batch;
  - every row then names the one before it. A missing, altered or reordered row breaks the chain
    and leaves a hole in `seq`, before archiving as well as after;
  - D1 has no interactive transactions, so the read and the increment go in the batch with a
    guard, as ADR 0050's guarded writes do;
  - the cost is one extra row written per audit row, for the counter.
- **The archive:** one object per day, `audit/YYYY/MM/DD.ndjson`. Its rows are in `seq` order, each
  the full row as stored, including `seq` and `prev_hash`.
- **The record of it:** a new table, `core_audit_archives (day, r2_key, first_seq, last_seq, rows,
  sha256, prev_sha256, archived_at)`. It is kept in D1 forever and is one row a day.
  - `sha256` is the object's digest.
  - `prev_sha256` is the previous day's digest.
- **How it stays verifiable:**
  - Recompute the day's digest from R2 and compare it with D1.
  - Check that the day's `seq` run is complete, and that each row's `prev_hash` matches the row
    before, across days and between the rows kept in D1 and those archived.
  - R2 objects are written once and never overwritten.
  - The cron archives and verifies one day per tick, in batches of a few hundred rows.
- **The trigger:** the no-delete trigger is replaced by one that refuses a DELETE unless an
  archive row covers the row's `seq`, and the row matches the "archived" class above. UPDATE stays
  refused. The table stays append-only for everything kept forever.

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

## The question for the owner
Keep everything in D1 forever, or archive the machine rows (runner, scheduler, foreman and intake
calls that were allowed and succeeded) to R2 after **90 days**, as a hash chain recorded in D1?
Decisions, refusals and gates stay in D1 either way. If you choose to archive: is 90 days right, and
may the no-delete trigger be replaced by one that allows only archived machine rows to be deleted?

-- job.claim reads the queue in claim order straight from an index (AGENTS.md "Cloudflare cost",
-- rules 1 and 2). Its order is released work first, then a shaping item's triage and planning jobs
-- (ADR 0493), each oldest first. That order came from the item's status, so the query sorted every
-- queued job in a temp B-tree before its LIMIT 50: with 1,000 queued, about 2,000 rows read a claim.

-- Whether the job was queued for an item still shaping (ADR 0493), set when it is queued. A job
-- queued while its item shapes keeps it: an item leaves shaping for `ready` (or is cancelled), and
-- the claim skips jobs whose item isn't running, waiting or shaping, so it never misorders work.
ALTER TABLE core_jobs ADD COLUMN shaping INTEGER NOT NULL DEFAULT 0;
UPDATE core_jobs SET shaping = 1
WHERE status = 'queued'
  AND work_item_id IN (SELECT id FROM core_work_items WHERE status = 'shaping');

-- Read by job.claim's candidates (packages/core/src/operations/runners.ts, `claimCandidates`):
-- `WHERE status = 'queued' ORDER BY shaping, created_at LIMIT 50`. Partial: it holds only queued
-- jobs, so the walk reads the 50 it takes and no more.
CREATE INDEX core_jobs_queue_idx ON core_jobs (shaping, created_at) WHERE status = 'queued';

UPDATE core_meta SET value = MAX(CAST(value AS INTEGER), 363) WHERE key = 'schema_version';

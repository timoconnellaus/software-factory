-- Migration 0434 (block AX): what a flow run's agent did (spec 70, the run view): its notes, tool
-- calls and tool results as the runner reported them, normalised to three kinds, and the run's
-- totals on its row. The runner's events were accepted and dropped before this.

-- A run's events, keyed by the runner's own per-job seq (it numbers every event it sends from 1, so
-- a gap is an event the engine didn't keep: a log line, a status change). `kind` is `note` (the
-- agent said something), `tool` (a call: name, short label, input) or `result` (a call's output);
-- `data` is that kind's JSON, each text capped at 4,000 characters (packages/store runEvents.ts).
-- At most 2,000 events a run; beyond that they are dropped and the run is marked truncated.
-- Retention: deleted 30 days after the run finished, by the cron's bounded prune
-- (pruneRunEvents: 500 rows a round, at most 4 rounds a tick), through flow_runs_events_due_idx.
-- The run row itself is kept. WITHOUT ROWID: every read and delete is by (run_id, seq).
-- The primary key is also the read's index: flow.run.events is `WHERE run_id = ? AND seq > ?
-- ORDER BY seq LIMIT 500`, and the prune's `WHERE run_id = ? ORDER BY seq LIMIT 500`.
CREATE TABLE flow_run_events (
  run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  org_id TEXT NOT NULL,
  at TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('note', 'tool', 'result')),
  data TEXT NOT NULL,
  PRIMARY KEY (run_id, seq)
) WITHOUT ROWID;

-- The run's totals, kept on its row: how many events are stored (the cap), the last seq stored
-- (a replayed batch adds nothing), its tool calls (`steps`), whether events were dropped, and
-- tokens and cost when the runner reports them (a stream-json session's `turn` reports tokens;
-- no runner reports cost, so cost_usd stays null until one does).
ALTER TABLE flow_runs ADD COLUMN event_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE flow_runs ADD COLUMN last_event_seq INTEGER NOT NULL DEFAULT 0;
ALTER TABLE flow_runs ADD COLUMN steps INTEGER NOT NULL DEFAULT 0;
ALTER TABLE flow_runs ADD COLUMN events_truncated INTEGER NOT NULL DEFAULT 0;
ALTER TABLE flow_runs ADD COLUMN tokens INTEGER;
ALTER TABLE flow_runs ADD COLUMN cost_usd REAL;

-- The prune (pruneRunEvents): `WHERE event_count > 0 AND finished_at < ? ORDER BY finished_at
-- LIMIT 1`. Partial, so it holds only runs that still have events: once a run's are deleted its
-- event_count goes to 0 and it leaves the index, so a tick with nothing due reads nothing.
CREATE INDEX flow_runs_events_due_idx ON flow_runs (finished_at) WHERE event_count > 0;

-- flow.inbox.get's `done` (inbox): the person's own finishes and decisions, newest first:
-- `WHERE org_id = ? AND kind = 'event' AND json_extract(data, '$.type') IN ('person.finished',
-- 'decided') AND json_extract(actor, '$.id') = ? ORDER BY created_at DESC LIMIT 100`. Partial and
-- on expressions, so only those events get an entry (no new column, and nothing for the kernel's
-- other events, effects or comments to write).
CREATE INDEX flow_events_person_done_idx
  ON flow_events (org_id, json_extract(actor, '$.id'), created_at)
  WHERE kind = 'event' AND json_extract(data, '$.type') IN ('person.finished', 'decided');

UPDATE core_meta SET value = MAX(CAST(value AS INTEGER), 434) WHERE key = 'schema_version';

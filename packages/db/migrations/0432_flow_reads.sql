-- Migration 0432 (block AX): indexes for the new core's reads the desktop app makes (spec 70):
-- an agent's runs, each project's count of open items, and the items waiting on a run.
--
-- Existing indexes these reads also use (named here, as 0430 can't be edited once applied):
-- flow_items_inbox_idx for flow.inbox.all's `work` and `decisions` arms (one per org, as
-- flow.inbox.get's), and for listAgents' `WHERE i.org_id = ? AND i.waiting_on = 'run'`;
-- flow_runs_item_idx for listAgents' join to each such item's run (`item_id = ? AND stay = ?`).

-- flow.run.list by agent (runsByAgent): `WHERE agent_id = ? AND org_id = ? ORDER BY created_at
-- DESC, rowid DESC LIMIT ?`.
CREATE INDEX flow_runs_agent_idx ON flow_runs (agent_id, created_at);

-- flow.project.list's openCount (listProjects): `WHERE org_id = ? AND (waiting_on <> 'nothing' OR
-- error IS NOT NULL) GROUP BY project_id`. Partial, so it holds only open items: the count reads
-- those and never the org's finished ones.
CREATE INDEX flow_items_open_idx ON flow_items (org_id, project_id)
  WHERE waiting_on <> 'nothing' OR error IS NOT NULL;

-- flow.inbox.all's `working` list (inboxAll): `WHERE i.org_id = ? AND i.waiting_on = 'run' ORDER BY
-- i.updated_at LIMIT 50`. flow_items_inbox_idx has waiting_ref (the agent) before updated_at, so it
-- would sort every item of the org waiting on a run; this partial index holds only those items, in
-- order.
CREATE INDEX flow_items_working_idx ON flow_items (org_id, updated_at) WHERE waiting_on = 'run';

UPDATE core_meta SET value = MAX(CAST(value AS INTEGER), 432) WHERE key = 'schema_version';

-- Migration 0100 (the merge queue, ADR 0330): approved merges land one at a time per project. An
-- entry is `queued` from approval until it merges or leaves; the project's head is its oldest
-- queued entry whose work item is still open. Rows are kept after they end, for the record.
CREATE TABLE core_merge_queue (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL REFERENCES core_projects (id) ON DELETE CASCADE,
  work_item_id TEXT NOT NULL REFERENCES core_work_items (id) ON DELETE CASCADE,
  -- The Workflow instance to wake when the entry reaches the head.
  workflow_id TEXT,
  -- The merge approval this entry lands with (null: a check-only auto-merge, ADR 0230).
  pending_action_id TEXT,
  -- The head a person approved, and the head the queue has brought up to date (a clean merge of
  -- the default branch into the approved head, made by GitHub's update-branch).
  approved_sha TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'merged', 'left')),
  end_reason TEXT,
  enqueued_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  ended_at TEXT
);
CREATE INDEX core_merge_queue_project_idx ON core_merge_queue (project_id, status, enqueued_at);
CREATE UNIQUE INDEX core_merge_queue_one_open_idx ON core_merge_queue (work_item_id)
  WHERE status = 'queued';

UPDATE core_meta SET value = MAX(CAST(value AS INTEGER), 100) WHERE key = 'schema_version';

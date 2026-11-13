-- Migration 0402 (block AU): what a split binds (review of #171, spec 24, ADR 0630).
-- A split's parent waiting for its children, after its plan merged: it holds no active slot
-- (the pull's count leaves it out), so its children can start under any activeLimit.
ALTER TABLE core_work_items ADD COLUMN awaiting_children INTEGER NOT NULL DEFAULT 0;
-- A plan's child: the slice a person approved with the parent's spec, as JSON {key, size, sha256}
-- (sha256 of its body and criteria). Triage lets it skip planning only while it still matches.
ALTER TABLE core_work_items ADD COLUMN split_slice TEXT;
-- What spec.commit wrote, as JSON [{path, sha256}]: a split parent's PR must hold exactly these,
-- with these contents, at the head verify judges.
ALTER TABLE core_specs ADD COLUMN committed_files TEXT;

UPDATE core_meta SET value = MAX(CAST(value AS INTEGER), 402) WHERE key = 'schema_version';

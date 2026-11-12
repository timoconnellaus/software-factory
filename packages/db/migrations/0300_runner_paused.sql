-- Migration 0300: why a runner takes nothing new in some pools for now (spec 43, ADR 0532): its
-- heartbeat's capacity.paused, as JSON ({ reason: "load" | "tmux", pools, load1?, cores?, detail? }), or
-- null when it takes work in every pool. The scheduler gives a paused pool nothing; the runner health
-- line says why ("busy: load").
ALTER TABLE core_runners ADD COLUMN paused TEXT;

UPDATE core_meta SET value = MAX(CAST(value AS INTEGER), 300) WHERE key = 'schema_version';

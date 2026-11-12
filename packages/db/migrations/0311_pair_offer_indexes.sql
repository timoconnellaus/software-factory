-- Migration 0311 (the phone app, spec 60 PR 1a follow-up, ADR 0541):
-- - core_pair_offers gains two indexes. mobile.pairOffer reads the live offers' tags (expires_at >
--   now) and counts one person's live offers (user_id, expires_at > now), and the minute cron
--   prunes offers a day past their expiry (expires_at < a day ago). Each scanned the table before.
-- - core_mobile_nonce_asks goes: the per-caller courtesy limit on mobile/nonce is now the engine's
--   Workers rate limiting binding (MOBILE_NONCE_LIMIT), checked before the call reaches D1, so an
--   anonymous caller can't make the factory write a row per address and five minutes.
CREATE INDEX core_pair_offers_expires_idx ON core_pair_offers (expires_at);
CREATE INDEX core_pair_offers_user_idx ON core_pair_offers (user_id, expires_at);

DROP TABLE core_mobile_nonce_asks;

UPDATE core_meta SET value = MAX(CAST(value AS INTEGER), 311) WHERE key = 'schema_version';

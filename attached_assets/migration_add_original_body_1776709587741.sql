-- Adds the original_body column to prospects for richer follow-up context.
-- Safe additive migration: nullable-equivalent (NOT NULL DEFAULT '') so existing
-- rows backfill to empty string and no data is lost. Idempotent via IF NOT EXISTS.
ALTER TABLE prospects
  ADD COLUMN IF NOT EXISTS original_body text NOT NULL DEFAULT '';

-- Deletes the 15 test-only prospects sent to hwholestorm@gmail.com and their follow-ups.
-- Run AFTER deploying the new build so subsequent syncs populate cleanly.
-- Safe: all 15 rows are Michael's own self-sends, not real prospects.
BEGIN;
DELETE FROM followups WHERE prospect_id IN (SELECT id FROM prospects WHERE email = 'hwholestorm@gmail.com');
DELETE FROM prospects WHERE email = 'hwholestorm@gmail.com';
SELECT COUNT(*) AS prospects_remaining FROM prospects;
COMMIT;

# Diagnostic F-D4 — Email Followupper health check

Workspace: Email Followupper (Doctrine Follow-up). Read-only, no fixes, no sends, no vendor calls. Output is a verdict table; any fix becomes its own order.

## Why now

The team uses this app daily and it has one recorded near-death: months of silent failure where a swallowed fallback path reported ok with synced:0. This week also proved fleet-wide that a Reserved VM's disk does not survive a publish and that workspace and deployment databases are separate stores. This diagnostic checks the living app against both lessons.

## Standing rule for every fact

Label its source: production HTTP surface, deployment log, workspace database, or repo code. The July 31 trap is on record — the workspace database once produced a false "dead since April" verdict while production was busy. Workspace-database numbers may be used only when explicitly labeled as such and never for production conclusions.

## Questions, in order

1. **Durability.** Where does production state actually live: engine, database host class (managed Postgres vs anything file-backed), and whether any state at all — attachments, exports, caches the app relies on — sits on the deployment filesystem. If everything is in managed Postgres, say so plainly and this question closes; if anything lives on disk, name it and its blast radius on the next publish.
2. **Liveness.** Cron heartbeats current as of now (the 48-hour-dead incident class); deployment up; last successful send with timestamp; queue depth and ages; anything overdue.
3. **Sending discipline.** Recent sends within the 8–18 UTC weekday window; the caps in force (the deliberately raised 1500/day, 60/hour) being respected; failure and bounce rates over the last 7 days, from production surfaces.
4. **Gmail and OAuth health.** Connected accounts now; any invalid_grant / deleted_client class errors in recent production logs; usage against the unverified-app 100-user lifetime cap.
5. **The silent-failure class.** Is the swallowed legacy-fallback path (the gmailSync ok-with-synced:0 shape) still capable of masking failure, and has any ok:0 pattern occurred in the last 14 days? Report, do not fix.
6. **Team pulse.** Per-user draft and send activity over the last 7 days from the production admin surface — is the team actually flowing through it.
7. **Verdict table**: one row per area above — healthy / degraded / action-needed — with the single most useful operator action where one exists, secret names only, never values.

## Hard rules

Read-only throughout: no code changes, no commits, no schema changes, no sends, no queue mutations, no secret values in any output. Production access only through the app's own HTTP surfaces with credentials already present in this workspace, plus deployment logs; the workspace database only with explicit labeling. Halt and ask if any question cannot be answered within these rules.

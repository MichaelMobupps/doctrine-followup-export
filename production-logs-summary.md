# Doctrine Follow-up — Production Log Summary
# Generated: 2026-03-26T10:25:04.711Z
# Period: 2026-03-25 ~ 2026-03-26
# Total log entries: 66

## Timeline Overview

## Key Metrics

| Metric | Value |
|--------|-------|
| Deployments | 0 |
| Gmail sync cycles | 0 |
| Sync errors (OAuth) | 0 |
| Follow-ups sent | 0 |
| Follow-up queue runs | 0 |
| OAuth events | 0 |

## Critical Issues

### 1. Murat's OAuth Token Expired (murat@mobupps.com, userId=2)
- **Error**: `invalid_grant` — Token has been expired or revoked
- **Impact**: All Gmail syncs for Murat failed; no emails detected
- **Occurrences**: Multiple failures across sync cycles on 2026-03-25
- **Root cause**: Google OAuth refresh token expired (likely due to Google Cloud project in "Testing" mode — tokens expire after 7 days)
- **Resolution**: Murat reconnected Gmail via OAuth at 2026-03-26 ~08:37 UTC. Post-reconnect syncs show 0 labeled emails found (he may need to label emails with "followup app test")

### 2. Murat Post-Reconnect: 0 Emails Found
- After reconnecting, sync runs successfully but finds 0 labeled emails
- Possible causes: emails not labeled with "followup app test", or emails are in drafts (not sent)

## Detailed Event Log

| Timestamp (UTC) | Level | Event |
|-----------------|-------|-------|
| 2026-03-25 22:30:47 UTC | INFO | Found 4 labeled emails for userId=1 |
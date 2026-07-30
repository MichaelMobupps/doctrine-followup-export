# Replit Agent Instructions — Follow-ups Page Overhaul

Give these instructions to the Replit agent verbatim:

---

I need you to make 3 changes. Do them in order.

## Change 1: Patch the `/api/followups` endpoint in `artifacts/api-server/src/routes/doctrine.ts`

Find the `router.get("/followups"` handler. In its `.select({...})` block, ADD these 4 fields after `originalSubject: prospectsTable.subject,`:

```
      batchLabel: prospectsTable.batchLabel,
      followupPaused: prospectsTable.followupPaused,
      replied: prospectsTable.replied,
      userMaxFollowups: usersTable.maxFollowups,
```

Then change `.innerJoin(prospectsTable, eq(followupsTable.prospectId, prospectsTable.id))` to:

```
    .innerJoin(prospectsTable, eq(followupsTable.prospectId, prospectsTable.id))
    .leftJoin(usersTable, eq(prospectsTable.userId, usersTable.id))
```

Then change `.limit(100)` to `.limit(500)`.

Then in the `result = rows.map(...)` block, ADD these 5 fields after `original_subject: r.originalSubject,`:

```
    batch_label: r.batchLabel,
    is_test_campaign: r.batchLabel === TEST_MODE_LABEL,
    followup_paused: r.followupPaused,
    replied: r.replied,
    max_followups: r.userMaxFollowups ?? 3,
```

## Change 2: Update the Followup schema in `lib/api-spec/openapi.yaml`

Find the `Followup:` schema. After the `original_subject` property, add:

```yaml
        batch_label:
          type: string
          nullable: true
        is_test_campaign:
          type: boolean
        followup_paused:
          type: boolean
        replied:
          type: integer
        max_followups:
          type: integer
```

Then run: `cd /home/runner/workspace && npx openapi-typescript lib/api-spec/openapi.yaml -o lib/api-client/src/generated.ts`

## Change 3: Replace `artifacts/dashboard/src/pages/followups.tsx` entirely

Replace the ENTIRE file with the content from the attached followups.tsx file.

---

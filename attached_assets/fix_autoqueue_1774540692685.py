filepath = "/home/runner/workspace/artifacts/api-server/src/services/scheduler.ts"
with open(filepath, "r") as f:
    c = f.read()

# Fix 1: Handle prospects with no followups at all (info is undefined)
# Fix 2: Remove the maxSentStage === 0 skip so Stage 1 gets auto-queued
old = """  for (const prospect of unrepliedProspects) {
    const info = prospectFollowupMap.get(prospect.id);
    if (!info || info.hasActive) continue;
    if (info.maxSentStage === 0) continue;

    const maxFollowups = maxFollowupsMap.get(prospect.userId!) || 10;
    const nextStage = info.maxSentStage + 1;"""

new = """  for (const prospect of unrepliedProspects) {
    const info = prospectFollowupMap.get(prospect.id);
    // Skip if there's already an active (queued/generating/pending) followup
    if (info?.hasActive) continue;

    const maxFollowups = maxFollowupsMap.get(prospect.userId!) || 10;
    const maxSent = info?.maxSentStage || 0;
    const nextStage = maxSent + 1;"""

if old in c:
    c = c.replace(old, new)
    with open(filepath, "w") as f:
        f.write(c)
    print("DONE: autoQueueAllCampaigns now auto-queues Stage 1 for new prospects")
else:
    print("ERROR: Could not find the code block to patch")

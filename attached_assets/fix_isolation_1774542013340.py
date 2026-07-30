import os

# ─── Fix 1: ApiKeyGate auto-resolves user when missing ───
filepath = "/home/runner/workspace/artifacts/dashboard/src/components/api-key-provider.tsx"
with open(filepath, "r") as f:
    c = f.read()

# Add auto-resolve: when apiKey exists but no currentUser, fetch accounts and find self
old_gate_end = '''  if (!apiKey) {'''

# We need to add a useEffect that runs when apiKey is set but user is null
resolve_block = '''  // Auto-resolve current user if apiKey exists but user identity is missing
  const { user: currentUser } = useCurrentUser();
  useEffect(() => {
    if (!apiKey || currentUser?.userId) return;
    const base = import.meta.env.BASE_URL || "/";
    // Try to find our account from the connected accounts list
    fetch(`${base}api/gmail/accounts`, { headers: { "x-api-key": apiKey } })
      .then(r => r.json())
      .then(data => {
        const accounts = data.accounts || [];
        if (accounts.length === 1) {
          // Single user — that's us
          setUser({ email: accounts[0].email, userId: accounts[0].id, name: accounts[0].name || accounts[0].email });
        } else if (accounts.length > 1) {
          // Multiple users — check stored email from last login
          const storedEmail = localStorage.getItem("doctrine_user_email");
          const me = storedEmail
            ? accounts.find((a: any) => a.email.toLowerCase() === storedEmail.toLowerCase())
            : null;
          if (me) {
            setUser({ email: me.email, userId: me.id, name: me.name || me.email });
          }
          // If can't determine, don't set — user will need to re-login
        }
      })
      .catch(() => {});
  }, [apiKey, currentUser?.userId]);

  if (!apiKey) {'''

# Only patch if not already patched
if "Auto-resolve current user" not in c:
    # Remove the duplicate destructure since we already have it above
    c = c.replace('  const { setUser } = useCurrentUser();\n', '  const { setUser } = useCurrentUser();\n')
    c = c.replace(old_gate_end, resolve_block)
    
    # Also store email during login exchange for multi-user resolution
    if 'doctrine_user_email' not in c:
        c = c.replace(
            'setUser({ email: data.email || "", userId: me?.id || null, name: me?.name || data.email || "" });',
            'localStorage.setItem("doctrine_user_email", data.email || "");\n                setUser({ email: data.email || "", userId: me?.id || null, name: me?.name || data.email || "" });'
        )
    
    with open(filepath, "w") as f:
        f.write(c)
    print("Fix 1: ApiKeyGate auto-resolves user identity when missing")
else:
    print("Fix 1: Already patched")

# ─── Fix 2: Auto-queue runs on 3-min tick too ───
filepath2 = "/home/runner/workspace/artifacts/api-server/src/cron.ts"
with open(filepath2, "r") as f:
    c2 = f.read()

if "autoQueueAllCampaigns" not in c2.split("*/3")[1] if "*/3" in c2 else "":
    # Add autoQueueAllCampaigns to the 3-minute tick
    old_3min = '''    try {
      const autoQueued = await autoQueueNextStages();
      if (autoQueued > 0) {
        logger.info({ autoQueued }, "Auto-queued next follow-up stages");
      }
    } catch (err) {
      logger.error({ err }, "Auto-queue error");
    }
  });'''
    
    new_3min = '''    try {
      const autoQueued = await autoQueueNextStages();
      if (autoQueued > 0) {
        logger.info({ autoQueued }, "Auto-queued next follow-up stages (test)");
      }
    } catch (err) {
      logger.error({ err }, "Auto-queue error");
    }

    try {
      const allQueued = await autoQueueAllCampaigns();
      if (allQueued > 0) {
        logger.info({ allQueued }, "Auto-queued follow-up stages (all campaigns, 3-min tick)");
      }
    } catch (err) {
      logger.error({ err }, "Auto-queue all error");
    }
  });'''
    
    c2 = c2.replace(old_3min, new_3min)
    with open(filepath2, "w") as f:
        f.write(c2)
    print("Fix 2: autoQueueAllCampaigns added to 3-minute tick")
else:
    print("Fix 2: Already on 3-min tick")

# ─── Fix 3: Followups page — add sent_at date to each thread card ───
filepath3 = "/home/runner/workspace/artifacts/dashboard/src/pages/followups.tsx"
with open(filepath3, "r") as f:
    c3 = f.read()

# The followups API doesn't return sent_at of the original prospect email.
# But we have created_at of the first followup which gives a chronological anchor.
# Let's add the original email date to the thread display.
# The API returns scheduled_at for each stage — we can use the earliest created_at.

# Add a date display to the thread summary row, next to the prospect name
old_name = '''                  {/* Prospect info */}
                  <div className="min-w-0 flex-1" style={{ maxWidth: "220px" }}>
                    <p className="font-medium text-[13px] truncate" style={{ color: "var(--text-primary)" }}>
                      {thread.prospect_name}
                    </p>
                    <p className="text-[12px] truncate" style={{ color: "var(--text-secondary)" }}>
                      {thread.company || thread.email}
                    </p>
                  </div>'''

new_name = '''                  {/* Prospect info */}
                  <div className="min-w-0 flex-1" style={{ maxWidth: "240px" }}>
                    <p className="font-medium text-[13px] truncate" style={{ color: "var(--text-primary)" }}>
                      {thread.prospect_name}
                    </p>
                    <div className="flex items-center gap-2">
                      <p className="text-[12px] truncate" style={{ color: "var(--text-secondary)" }}>
                        {thread.company || thread.email}
                      </p>
                      <span className="text-[10px] font-mono flex-shrink-0" style={{ color: "var(--text-tertiary)" }}>
                        {thread.stages.length > 0 ? new Date(thread.stages[0].created_at).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : ""}
                      </span>
                    </div>
                  </div>'''

if old_name in c3:
    c3 = c3.replace(old_name, new_name)
    with open(filepath3, "w") as f:
        f.write(c3)
    print("Fix 3: Followups thread cards now show campaign date")
else:
    print("Fix 3: Could not find the exact block to patch in followups.tsx")

print("\nAll fixes applied. Run: cd /home/runner/workspace && bash source-code/sync.sh")

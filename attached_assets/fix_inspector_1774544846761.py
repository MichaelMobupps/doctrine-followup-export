filepath = "/home/runner/workspace/artifacts/dashboard/src/pages/email-inspector.tsx"
with open(filepath, "r") as f:
    c = f.read()

# 1. Force selectedUserId from currentUser only — no account picker
old_effect = '''  useEffect(() => {
    if (!selectedUserId && accounts.length > 0 && currentUser?.userId) {
      setSelectedUserId(String(currentUser.userId));
    } else if (!selectedUserId && accounts.length > 0) {
      setSelectedUserId(String(accounts[0].id));
    }
  }, [accounts, currentUser]);'''

new_effect = '''  useEffect(() => {
    if (currentUser?.userId) {
      setSelectedUserId(String(currentUser.userId));
    }
  }, [currentUser?.userId]);'''

c = c.replace(old_effect, new_effect)

# 2. Remove the account dropdown entirely — replace with a static label
old_dropdown = '''        {accounts.length > 1 && (
          <Select
            value={selectedUserId}
            onChange={(e) => setSelectedUserId(e.target.value)}
            className="w-52"
          >
            {accounts.map((a: any) => (
              <option key={a.id} value={String(a.id)}>{a.email}</option>
            ))}
          </Select>
        )}'''

new_label = '''        <div
          className="h-9 rounded-md px-3 text-[13px] flex items-center w-52"
          style={{
            background: "var(--bg-tertiary)",
            border: "1px solid var(--border-default)",
            color: "var(--text-secondary)",
          }}
        >
          {currentUser?.email || "Loading..."}
        </div>'''

if old_dropdown in c:
    c = c.replace(old_dropdown, new_label)
    print("Dropdown replaced with static label")
else:
    print("WARNING: Could not find dropdown block, trying alternate pattern...")
    # Try the raw select pattern from the earlier deploy
    if '<select' in c and 'selectedUserId' in c:
        import re
        c = re.sub(
            r'<select[^>]*value=\{selectedUserId\}[^]*?</select>',
            new_label.strip(),
            c,
            count=1
        )
        print("Replaced via regex")

with open(filepath, "w") as f:
    f.write(c)
print("email-inspector.tsx: locked to current user only")

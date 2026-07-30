import type { gmail_v1 } from "googleapis";

/**
 * Label names used by the follow-up app.
 * These must match what createLabels.ts creates and what gmailSync.ts searches for.
 */
const PARENT_LABEL_NAME = "Doctrine SDR";

const VERTICAL_LABEL_NAMES: Record<string, string> = {
  gaming_ua: "Doctrine SDR/gaming-ua",
  non_gaming_ua: "Doctrine SDR/non-gaming-ua",
  cps: "Doctrine SDR/cps",
  retargeting: "Doctrine SDR/retargeting",
};

/**
 * Per-user cache of label name → label ID.
 * Keyed by the OAuth refresh token (unique per user).
 * TTL: 10 minutes — avoids hitting labels.list on every email,
 * but refreshes often enough to pick up newly-created labels.
 */
interface CacheEntry {
  map: Map<string, string>;
  expiresAt: number;
}

const CACHE_TTL_MS = 10 * 60 * 1000;
const labelCache = new Map<string, CacheEntry>();

/**
 * Derive a stable cache key from the gmail client's auth credentials.
 */
function getCacheKey(gmail: gmail_v1.Gmail): string {
  const auth = (gmail as any)._options?.auth;
  const token = auth?.credentials?.refresh_token || "";
  // Use last 16 chars of refresh token as key — unique per user, not sensitive in-memory
  return token ? token.slice(-16) : `fallback-${Date.now()}`;
}

/**
 * Fetch the full label name→ID map for the authenticated user, with caching.
 */
async function getLabelMap(
  gmail: gmail_v1.Gmail,
  cacheKey: string,
): Promise<Map<string, string>> {
  const cached = labelCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.map;
  }

  const res = await gmail.users.labels.list({ userId: "me" });
  const labels = res.data.labels || [];

  const map = new Map<string, string>();
  for (const label of labels) {
    if (label.name && label.id) {
      map.set(label.name.toLowerCase(), label.id);
    }
  }

  labelCache.set(cacheKey, { map, expiresAt: Date.now() + CACHE_TTL_MS });
  return map;
}

/**
 * Resolve a Gmail label name to its ID for the authenticated user.
 * Creates the label if it doesn't exist yet on that user's mailbox.
 */
async function resolveOrCreateLabel(
  gmail: gmail_v1.Gmail,
  labelName: string,
  cacheKey: string,
): Promise<string | null> {
  try {
    const map = await getLabelMap(gmail, cacheKey);
    const id = map.get(labelName.toLowerCase());
    if (id) return id;
  } catch (err: any) {
    console.error(`[followup-label] Failed to list labels: ${err.message}`);
    return null;
  }

  // Label doesn't exist on this user's mailbox — create it
  try {
    const created = await gmail.users.labels.create({
      userId: "me",
      requestBody: {
        name: labelName,
        labelListVisibility: "labelShow",
        messageListVisibility: "show",
      },
    });

    const newId = created.data.id || null;
    if (newId) {
      // Update the cache inline
      const entry = labelCache.get(cacheKey);
      if (entry) {
        entry.map.set(labelName.toLowerCase(), newId);
      }
      console.log(`[followup-label] Created label "${labelName}" (ID: ${newId}) for user`);
    }
    return newId;
  } catch (err: any) {
    if (err.code === 409) {
      // Race condition — label was created between list and create.
      // Invalidate cache so next call resolves it.
      labelCache.delete(cacheKey);
      console.log(`[followup-label] Label "${labelName}" conflict — will resolve next call`);
    } else {
      console.error(`[followup-label] Failed to create label "${labelName}": ${err.message}`);
    }
    return null;
  }
}

export async function labelSentEmail(
  gmail: gmail_v1.Gmail,
  messageId: string,
  vertical?: string,
): Promise<void> {
  const cacheKey = getCacheKey(gmail);

  const parentLabelId = await resolveOrCreateLabel(gmail, PARENT_LABEL_NAME, cacheKey);

  if (!parentLabelId) {
    console.warn(`[followup-label] Could not resolve parent label "${PARENT_LABEL_NAME}" — skipping`);
    return;
  }

  const labelIds: string[] = [parentLabelId];

  if (vertical && VERTICAL_LABEL_NAMES[vertical]) {
    const verticalLabelId = await resolveOrCreateLabel(
      gmail,
      VERTICAL_LABEL_NAMES[vertical],
      cacheKey,
    );
    if (verticalLabelId) {
      labelIds.push(verticalLabelId);
    }
  }

  try {
    await gmail.users.messages.modify({
      userId: "me",
      id: messageId,
      requestBody: {
        addLabelIds: labelIds,
      },
    });
  } catch (err: any) {
    console.error(`[followup-label] Failed to label message ${messageId}: ${err.message}`);
  }
}

export async function labelAfterSend(
  gmail: gmail_v1.Gmail,
  messageId: string | null | undefined,
  vertical?: string,
): Promise<void> {
  if (!messageId) return;
  await labelSentEmail(gmail, messageId, vertical);
}

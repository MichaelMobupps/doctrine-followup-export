// B7r: per-request usage attribution propagated via AsyncLocalStorage.
//
// We attach this context once at the scheduler level, then read it
// from inside the generator's anthropic call sites. This avoids
// threading 4 extra parameters through every generator function
// signature.
//
// Pattern: scheduler.ts wraps the generator call in
//   runWithUsageContext({...}, () => generateFollowupEmail(ctx))
// and recordUsage() inside usageTracker.ts calls getUsageContext()
// to know which followup the call belongs to.

import { AsyncLocalStorage } from "node:async_hooks";

export interface UsageAttribution {
  followupId: number | null;
  prospectId: number | null;
  userId: number | null;
  app: "doctrine" | "context" | "anti_ghosting";
  stage: number;
}

const storage = new AsyncLocalStorage<UsageAttribution>();

export function runWithUsageContext<T>(attr: UsageAttribution, fn: () => Promise<T>): Promise<T> {
  return storage.run(attr, fn);
}

export function getUsageContext(): UsageAttribution | undefined {
  return storage.getStore();
}

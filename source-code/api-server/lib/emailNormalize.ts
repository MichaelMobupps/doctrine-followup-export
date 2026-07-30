// Pure email normalization. No database or network imports, so it can be
// unit-tested without loading the workspace DB package. suppression.ts
// re-exports normalizeEmail from here, so existing call sites are unchanged.

export function normalizeEmail(email: string): string {
  return (email || "").trim().toLowerCase();
}

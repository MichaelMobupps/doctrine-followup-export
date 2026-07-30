import { pgTable, serial, text, timestamp, index } from "drizzle-orm/pg-core";

export const oauthNoncesTable = pgTable("oauth_nonces", {
  id: serial("id").primaryKey(),
  nonce: text("nonce").notNull().unique(),
  flowType: text("flow_type").notNull(),
  metadata: text("metadata"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("idx_oauth_nonces_nonce").on(table.nonce),
  index("idx_oauth_nonces_expires_at").on(table.expiresAt),
]);

export type OAuthNonce = typeof oauthNoncesTable.$inferSelect;

import {
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

/**
 * Replay defense for provider ID-JAGs (issuer + jti). Insert-or-conflict is
 * the compare-and-set: two replicas cannot both mint a registration from one
 * assertion.
 */
export const agentProviderAssertionReplays = pgTable(
  "agent_provider_assertion_replays",
  {
    issuer: text("issuer").notNull(),
    jti: text("jti").notNull(),
    expiresAt: timestamp("expires_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({
      name: "agent_provider_assertion_replays_pk",
      columns: [t.issuer, t.jti],
    }),
    index("agent_provider_assertion_replays_expires_idx").on(t.expiresAt),
  ],
);

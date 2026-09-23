import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * One row per pairwise sector key: which owner holds it.
 *
 * `oauth_clients.sector_key` decides the pairwise `sub`, so two owners on one
 * key see the same subject for the same person. One owner may reuse a key
 * across their own clients; a second owner may not. A plain unique index on
 * `oauth_clients.sector_key` cannot say that (it would also forbid the one
 * owner's second client), so the key is claimed here and the primary key is
 * the arbiter: concurrent registrations on one key serialize on this row
 * (`insert ... on conflict do nothing`, then `select ... for update`), and the
 * loser is refused rather than admitted beside the winner.
 *
 * `owner_key` is the owning principal id, or `client:<id>` for a client with
 * no owner, so an ownerless client can never share a key with anybody.
 */
export const oauthClientSectorClaims = pgTable("oauth_client_sector_claims", {
  sectorKey: text("sector_key").primaryKey(),
  ownerKey: text("owner_key").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow(),
});

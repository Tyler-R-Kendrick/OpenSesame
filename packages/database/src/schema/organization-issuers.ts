import { pgTable, text } from "drizzle-orm/pg-core";
import { organizations } from "./index.js";

/** One normalized issuer has one owner across both federation protocols. */
export const organizationIssuerClaims = pgTable("organization_issuer_claims", {
  issuer: text("issuer").primaryKey(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
});

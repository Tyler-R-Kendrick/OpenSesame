import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Database } from "./repos/postgres.js";
import * as schema from "./schema/index.js";

/**
 * Pairwise subject persistence — structural type matching
 * `PairwiseSubjectStore` in `@opensesame/oauth-provider`. This package must
 * not import the issuer.
 */
export interface PairwiseSubjectRecord {
  principalId: string;
  sectorIdentifier: string;
  subject: string;
  createdAt: Date;
}

export interface PairwiseSubjectStore {
  getOrCreate(
    principalId: string,
    sectorIdentifier: string,
  ): Promise<PairwiseSubjectRecord>;
  find(
    principalId: string,
    sectorIdentifier: string,
  ): Promise<PairwiseSubjectRecord | undefined>;
}

function mapRow(
  row: typeof schema.pairwiseSubjects.$inferSelect,
): PairwiseSubjectRecord {
  return {
    principalId: row.principalId,
    sectorIdentifier: row.sectorIdentifier,
    subject: row.subject,
    createdAt: row.createdAt,
  };
}

/**
 * Postgres pairwise `sub` mapping. Random subjects are minted once per
 * (principal, sector) and reused across processes so RP-facing identifiers
 * stay stable.
 *
 * `principal_id` is a FK to `principals`. Callers must persist the principal
 * before minting a pairwise subject.
 */
export function createPostgresPairwiseStore(
  db: Database,
): PairwiseSubjectStore {
  const pair = (principalId: string, sectorIdentifier: string) =>
    and(
      eq(schema.pairwiseSubjects.principalId, principalId),
      eq(schema.pairwiseSubjects.sectorIdentifier, sectorIdentifier),
    );

  return {
    async find(principalId, sectorIdentifier) {
      const [row] = await db
        .select()
        .from(schema.pairwiseSubjects)
        .where(pair(principalId, sectorIdentifier))
        .limit(1);
      return row ? mapRow(row) : undefined;
    },

    async getOrCreate(principalId, sectorIdentifier) {
      const existing = await this.find(principalId, sectorIdentifier);
      if (existing) return existing;

      const subject = randomBytes(32).toString("base64url");
      try {
        const [row] = await db
          .insert(schema.pairwiseSubjects)
          .values({ principalId, sectorIdentifier, subject })
          .onConflictDoNothing()
          .returning();
        if (row) return mapRow(row);
      } catch (err) {
        // FK miss: principal was never stored. Fail closed rather than mint
        // an in-memory subject that would churn on the next process.
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(
          `pairwise subject insert failed for principal ${principalId}: ${message}`,
        );
      }

      const raced = await this.find(principalId, sectorIdentifier);
      if (!raced) {
        throw new Error(
          `pairwise subject missing after conflict for principal ${principalId}`,
        );
      }
      return raced;
    },
  };
}

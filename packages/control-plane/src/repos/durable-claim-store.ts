import {
  ConflictError,
  type Database,
  PostgresRepositories,
  claimItems,
  claimSessions,
} from "@opensesame/database";
import type { ClaimItem, ClaimSession } from "@opensesame/os-domain";
import { DomainError } from "@opensesame/os-domain";
import { and, eq, gt, notInArray } from "drizzle-orm";

/** The claim engine and HTTP quota view share the same durable rows. */
export class DurableClaimStore {
  private readonly repos: PostgresRepositories;
  constructor(private readonly db: Database) {
    this.repos = new PostgresRepositories(db);
  }

  async listSessions(principalId?: string): Promise<ClaimSession[]> {
    const rows = await this.db
      .select({ id: claimSessions.id })
      .from(claimSessions)
      .where(
        principalId
          ? and(
              eq(claimSessions.creatorPrincipalId, principalId),
              gt(claimSessions.expiresAt, new Date()),
              notInArray(claimSessions.state, [
                "completed",
                "denied",
                "revoked",
                "expired",
              ]),
            )
          : undefined,
      )
      .limit(10_000);
    const sessions = await Promise.all(rows.map(({ id }) => this.get(id)));
    return sessions.filter(
      (session): session is ClaimSession => session !== undefined,
    );
  }

  async get(id: string): Promise<ClaimSession | undefined> {
    return (await this.repos.claimSessions.getById(id)) ?? undefined;
  }

  getItems(id: string): Promise<ClaimItem[]> {
    return this.repos.claimItems.listByClaim(id);
  }

  async putItems(claimId: string, items: ClaimItem[]): Promise<void> {
    await this.db.transaction(async (tx) => {
      for (const item of items) {
        if (item.claimId !== claimId)
          throw new DomainError("CONFLICT", "Claim item binding mismatch");
        const updated = await tx
          .update(claimItems)
          .set({ state: item.state })
          .where(
            and(eq(claimItems.id, item.id), eq(claimItems.claimId, claimId)),
          )
          .returning({ id: claimItems.id });
        if (updated.length !== 1)
          throw new DomainError("NOT_FOUND", "Claim item not found");
      }
    });
  }

  create(session: ClaimSession, items: ClaimItem[]): Promise<ClaimSession> {
    return this.repos.transaction(async (uow) => {
      const created = await this.repos.claimSessions.create(session, uow);
      for (const item of items) {
        if (item.claimId !== session.id)
          throw new DomainError("CONFLICT", "Claim item binding mismatch");
        await this.repos.claimItems.create(item, uow);
      }
      return created;
    });
  }

  async compareAndSwap(
    id: string,
    expectedVersion: number,
    next: ClaimSession,
  ) {
    const current = await this.get(id);
    if (!current) throw new DomainError("NOT_FOUND", "Claim not found");
    if (current.targetManifestDigest !== next.targetManifestDigest) {
      throw new DomainError(
        "IMMUTABLE_FIELD",
        "targetManifestDigest is immutable",
      );
    }
    try {
      const session = await this.repos.claimSessions.updateWithVersion(
        id,
        expectedVersion,
        next,
      );
      return { session, won: true };
    } catch (error) {
      if (!(error instanceof ConflictError)) throw error;
      const session = await this.get(id);
      if (!session) throw new DomainError("NOT_FOUND", "Claim not found");
      return { session, won: false };
    }
  }
}

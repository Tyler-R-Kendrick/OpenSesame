import type {
  AgentAccessTokenRecord,
  AgentClaimAttempt,
  AgentRegistration,
  AgentServiceAssertionRecord,
} from "@opensesame/os-domain";
import { and, desc, eq, isNull, lte, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from "../schema/index.js";
import {
  type AgentAuthRepository,
  ConflictError,
  type UnitOfWork,
} from "./interfaces.js";

function digestKey(digest: Uint8Array): string {
  return Buffer.from(digest).toString("hex");
}

function applyNowOrDefer(uow: UnitOfWork | undefined, apply: () => void): void {
  if (uow?.defer) {
    uow.defer(apply);
    return;
  }
  apply();
}

function cloneRegistration(row: AgentRegistration): AgentRegistration {
  const next: AgentRegistration = {
    ...row,
    preClaimScopes: [...row.preClaimScopes],
    postClaimScopes: [...row.postClaimScopes],
  };
  if (row.claimTokenDigest) {
    next.claimTokenDigest = new Uint8Array(row.claimTokenDigest);
  }
  return next;
}

function cloneAttempt(row: AgentClaimAttempt): AgentClaimAttempt {
  return {
    ...row,
    attemptTokenDigest: new Uint8Array(row.attemptTokenDigest),
    userCodeDigest: new Uint8Array(row.userCodeDigest),
  };
}

function cloneAccess(row: AgentAccessTokenRecord): AgentAccessTokenRecord {
  return {
    ...row,
    scopes: [...row.scopes],
    tokenDigest: new Uint8Array(row.tokenDigest),
  };
}

function cloneAssertion(
  row: AgentServiceAssertionRecord,
): AgentServiceAssertionRecord {
  return { ...row };
}

export class MemoryAgentAuthRepository implements AgentAuthRepository {
  readonly registrations = new Map<string, AgentRegistration>();
  readonly claimDigests = new Map<string, string>();
  readonly attempts = new Map<string, AgentClaimAttempt>();
  readonly attemptDigests = new Map<string, string>();
  readonly accessTokens = new Map<string, AgentAccessTokenRecord>();
  readonly accessDigests = new Map<string, string>();
  readonly assertions = new Map<string, AgentServiceAssertionRecord>();

  createRegistration = async (
    registration: AgentRegistration,
    uow?: UnitOfWork,
  ): Promise<AgentRegistration> => {
    if (this.registrations.has(registration.id)) {
      throw new ConflictError(`agent registration exists: ${registration.id}`);
    }
    const digest = registration.claimTokenDigest
      ? digestKey(registration.claimTokenDigest)
      : undefined;
    if (digest && this.claimDigests.has(digest)) {
      throw new ConflictError("agent claim token digest collision");
    }
    const row = cloneRegistration(registration);
    applyNowOrDefer(uow, () => {
      if (this.registrations.has(row.id)) {
        throw new ConflictError(`agent registration exists: ${row.id}`);
      }
      if (digest && this.claimDigests.has(digest)) {
        throw new ConflictError("agent claim token digest collision");
      }
      this.registrations.set(row.id, row);
      if (digest) this.claimDigests.set(digest, row.id);
    });
    return cloneRegistration(row);
  };

  getRegistrationById = async (
    id: string,
  ): Promise<AgentRegistration | null> => {
    const row = this.registrations.get(id);
    return row ? cloneRegistration(row) : null;
  };

  getRegistrationByClaimTokenDigest = async (
    digest: Uint8Array,
  ): Promise<AgentRegistration | null> => {
    const id = this.claimDigests.get(digestKey(digest));
    if (!id) return null;
    return this.getRegistrationById(id);
  };

  compareAndSetRegistration = async (
    expectedVersion: number,
    next: AgentRegistration,
    uow?: UnitOfWork,
  ): Promise<AgentRegistration> => {
    const current = this.registrations.get(next.id);
    if (!current || current.version !== expectedVersion) {
      throw new ConflictError(`agent registration cas failed: ${next.id}`);
    }
    const row = cloneRegistration({ ...next, version: expectedVersion + 1 });
    applyNowOrDefer(uow, () => {
      const live = this.registrations.get(next.id);
      if (!live || live.version !== expectedVersion) {
        throw new ConflictError(`agent registration cas failed: ${next.id}`);
      }
      this.registrations.set(row.id, row);
    });
    return cloneRegistration(row);
  };

  expireDue = async (now: Date): Promise<number> => {
    let n = 0;
    for (const [id, row] of this.registrations) {
      if (
        row.expiresAt.getTime() <= now.getTime() &&
        (row.status === "unclaimed" || row.status === "claim_pending")
      ) {
        this.registrations.set(id, {
          ...row,
          status: "expired",
          version: row.version + 1,
        });
        n += 1;
      }
    }
    return n;
  };

  createClaimAttempt = async (
    attempt: AgentClaimAttempt,
    uow?: UnitOfWork,
  ): Promise<AgentClaimAttempt> => {
    const key = digestKey(attempt.attemptTokenDigest);
    if (this.attempts.has(attempt.id) || this.attemptDigests.has(key)) {
      throw new ConflictError("agent claim attempt collision");
    }
    const row = cloneAttempt(attempt);
    applyNowOrDefer(uow, () => {
      if (this.attempts.has(row.id) || this.attemptDigests.has(key)) {
        throw new ConflictError("agent claim attempt collision");
      }
      this.attempts.set(row.id, row);
      this.attemptDigests.set(key, row.id);
    });
    return cloneAttempt(row);
  };

  getClaimAttemptById = async (
    id: string,
  ): Promise<AgentClaimAttempt | null> => {
    const row = this.attempts.get(id);
    return row ? cloneAttempt(row) : null;
  };

  getClaimAttemptByTokenDigest = async (
    digest: Uint8Array,
  ): Promise<AgentClaimAttempt | null> => {
    const id = this.attemptDigests.get(digestKey(digest));
    if (!id) return null;
    return this.getClaimAttemptById(id);
  };

  latestClaimAttempt = async (
    registrationId: string,
  ): Promise<AgentClaimAttempt | null> => {
    let latest: AgentClaimAttempt | null = null;
    for (const row of this.attempts.values()) {
      if (row.registrationId !== registrationId) continue;
      if (!latest || row.createdAt > latest.createdAt) latest = row;
    }
    return latest ? cloneAttempt(latest) : null;
  };

  updateClaimAttempt = async (
    attempt: AgentClaimAttempt,
    uow?: UnitOfWork,
  ): Promise<AgentClaimAttempt> => {
    if (!this.attempts.has(attempt.id)) {
      throw new ConflictError(`agent claim attempt missing: ${attempt.id}`);
    }
    const row = cloneAttempt(attempt);
    applyNowOrDefer(uow, () => {
      this.attempts.set(row.id, row);
    });
    return cloneAttempt(row);
  };

  createAccessToken = async (
    record: AgentAccessTokenRecord,
    uow?: UnitOfWork,
  ): Promise<AgentAccessTokenRecord> => {
    const key = digestKey(record.tokenDigest);
    if (this.accessTokens.has(record.id) || this.accessDigests.has(key)) {
      throw new ConflictError("agent access token collision");
    }
    const row = cloneAccess(record);
    applyNowOrDefer(uow, () => {
      if (this.accessTokens.has(row.id) || this.accessDigests.has(key)) {
        throw new ConflictError("agent access token collision");
      }
      this.accessTokens.set(row.id, row);
      this.accessDigests.set(key, row.id);
    });
    return cloneAccess(row);
  };

  getAccessTokenByDigest = async (
    digest: Uint8Array,
  ): Promise<AgentAccessTokenRecord | null> => {
    const id = this.accessDigests.get(digestKey(digest));
    if (!id) return null;
    const row = this.accessTokens.get(id);
    return row ? cloneAccess(row) : null;
  };

  revokeAccessToken = async (
    id: string,
    at: Date,
    uow?: UnitOfWork,
  ): Promise<void> => {
    const row = this.accessTokens.get(id);
    if (!row || row.revokedAt) return;
    applyNowOrDefer(uow, () => {
      const live = this.accessTokens.get(id);
      if (!live || live.revokedAt) return;
      this.accessTokens.set(id, { ...live, revokedAt: at });
    });
  };

  revokeAccessTokensForRegistration = async (
    registrationId: string,
    at: Date,
    onlyUnclaimed: boolean,
    uow?: UnitOfWork,
  ): Promise<number> => {
    const ids: string[] = [];
    for (const [id, row] of this.accessTokens) {
      if (row.registrationId !== registrationId || row.revokedAt) continue;
      if (onlyUnclaimed && row.claimed) continue;
      ids.push(id);
    }
    applyNowOrDefer(uow, () => {
      for (const id of ids) {
        const live = this.accessTokens.get(id);
        if (!live || live.revokedAt) continue;
        this.accessTokens.set(id, { ...live, revokedAt: at });
      }
    });
    return ids.length;
  };

  createAssertion = async (
    record: AgentServiceAssertionRecord,
    uow?: UnitOfWork,
  ): Promise<AgentServiceAssertionRecord> => {
    if (this.assertions.has(record.jti)) {
      throw new ConflictError(`agent assertion jti exists: ${record.jti}`);
    }
    const row = cloneAssertion(record);
    applyNowOrDefer(uow, () => {
      if (this.assertions.has(row.jti)) {
        throw new ConflictError(`agent assertion jti exists: ${row.jti}`);
      }
      this.assertions.set(row.jti, row);
    });
    return cloneAssertion(row);
  };

  getAssertionByJti = async (
    jti: string,
  ): Promise<AgentServiceAssertionRecord | null> => {
    const row = this.assertions.get(jti);
    return row ? cloneAssertion(row) : null;
  };

  revokeAssertionsForRegistration = async (
    registrationId: string,
    at: Date,
    belowVersion?: number,
    uow?: UnitOfWork,
  ): Promise<number> => {
    const jtis: string[] = [];
    for (const [jti, row] of this.assertions) {
      if (row.registrationId !== registrationId || row.revokedAt) continue;
      if (belowVersion !== undefined && row.assertionVersion >= belowVersion) {
        continue;
      }
      jtis.push(jti);
    }
    applyNowOrDefer(uow, () => {
      for (const jti of jtis) {
        const live = this.assertions.get(jti);
        if (!live || live.revokedAt) continue;
        this.assertions.set(jti, { ...live, revokedAt: at });
      }
    });
    return jtis.length;
  };

  countLiveRegistrations = async (): Promise<number> => {
    let n = 0;
    for (const row of this.registrations.values()) {
      if (row.status === "unclaimed" || row.status === "claim_pending") n += 1;
    }
    return n;
  };
}

type Db = PostgresJsDatabase<typeof schema>;

function mapRegistration(
  row: typeof schema.agentRegistrations.$inferSelect,
): AgentRegistration {
  const mapped: AgentRegistration = {
    id: row.id,
    kind: row.kind as AgentRegistration["kind"],
    status: row.status as AgentRegistration["status"],
    principalId: row.principalId,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    preClaimScopes: row.preClaimScopes,
    postClaimScopes: row.postClaimScopes,
    assertionVersion: row.assertionVersion,
    version: row.version,
  };
  if (row.claimedByPrincipalId)
    mapped.claimedByPrincipalId = row.claimedByPrincipalId;
  if (row.claimedAt) mapped.claimedAt = row.claimedAt;
  if (row.revokedAt) mapped.revokedAt = row.revokedAt;
  if (row.resource) mapped.resource = row.resource;
  if (row.audience) mapped.audience = row.audience;
  if (row.claimEmailNormalized)
    mapped.claimEmailNormalized = row.claimEmailNormalized;
  if (row.claimTokenDigest) mapped.claimTokenDigest = row.claimTokenDigest;
  if (row.providerIssuer) mapped.providerIssuer = row.providerIssuer;
  if (row.providerSubject) mapped.providerSubject = row.providerSubject;
  if (row.providerClientId) mapped.providerClientId = row.providerClientId;
  return mapped;
}

function mapAttempt(
  row: typeof schema.agentClaimAttempts.$inferSelect,
): AgentClaimAttempt {
  const mapped: AgentClaimAttempt = {
    id: row.id,
    registrationId: row.registrationId,
    attemptTokenDigest: row.attemptTokenDigest,
    userCodeDigest: row.userCodeDigest,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    intervalSeconds: row.intervalSeconds,
    pollCount: row.pollCount,
    failedAttempts: row.failedAttempts,
  };
  if (row.emailNormalized) mapped.emailNormalized = row.emailNormalized;
  if (row.slowdownUntil) mapped.slowdownUntil = row.slowdownUntil;
  if (row.completedAt) mapped.completedAt = row.completedAt;
  return mapped;
}

function mapAccess(
  row: typeof schema.agentAccessTokens.$inferSelect,
): AgentAccessTokenRecord {
  const mapped: AgentAccessTokenRecord = {
    id: row.id,
    registrationId: row.registrationId,
    tokenDigest: row.tokenDigest,
    scopes: row.scopes,
    claimed: row.claimed,
    assertionVersion: row.assertionVersion,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
  };
  if (row.resource) mapped.resource = row.resource;
  if (row.revokedAt) mapped.revokedAt = row.revokedAt;
  return mapped;
}

function mapAssertion(
  row: typeof schema.agentServiceAssertions.$inferSelect,
): AgentServiceAssertionRecord {
  const mapped: AgentServiceAssertionRecord = {
    jti: row.jti,
    registrationId: row.registrationId,
    assertionVersion: row.assertionVersion,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
  };
  if (row.revokedAt) mapped.revokedAt = row.revokedAt;
  return mapped;
}

export function createPostgresAgentAuthRepository(
  db: Db,
  resolveDb: (uow?: UnitOfWork) => Db,
): AgentAuthRepository {
  return {
    async createRegistration(registration, uow) {
      const conn = resolveDb(uow);
      const [row] = await conn
        .insert(schema.agentRegistrations)
        .values({
          id: registration.id,
          kind: registration.kind,
          status: registration.status,
          principalId: registration.principalId,
          claimedByPrincipalId: registration.claimedByPrincipalId,
          createdAt: registration.createdAt,
          updatedAt: registration.createdAt,
          expiresAt: registration.expiresAt,
          claimedAt: registration.claimedAt,
          revokedAt: registration.revokedAt,
          preClaimScopes: registration.preClaimScopes,
          postClaimScopes: registration.postClaimScopes,
          resource: registration.resource,
          audience: registration.audience,
          claimEmailNormalized: registration.claimEmailNormalized,
          claimTokenDigest: registration.claimTokenDigest,
          assertionVersion: registration.assertionVersion,
          providerIssuer: registration.providerIssuer,
          providerSubject: registration.providerSubject,
          providerClientId: registration.providerClientId,
          version: registration.version,
        })
        .returning();
      if (!row) throw new Error("failed to insert agent registration");
      return mapRegistration(row);
    },

    async getRegistrationById(id) {
      const [row] = await db
        .select()
        .from(schema.agentRegistrations)
        .where(eq(schema.agentRegistrations.id, id))
        .limit(1);
      return row ? mapRegistration(row) : null;
    },

    async getRegistrationByClaimTokenDigest(digest) {
      const [row] = await db
        .select()
        .from(schema.agentRegistrations)
        .where(eq(schema.agentRegistrations.claimTokenDigest, digest))
        .limit(1);
      return row ? mapRegistration(row) : null;
    },

    async compareAndSetRegistration(expectedVersion, next, uow) {
      const conn = resolveDb(uow);
      const [row] = await conn
        .update(schema.agentRegistrations)
        .set({
          kind: next.kind,
          status: next.status,
          principalId: next.principalId,
          claimedByPrincipalId: next.claimedByPrincipalId,
          expiresAt: next.expiresAt,
          claimedAt: next.claimedAt,
          revokedAt: next.revokedAt,
          preClaimScopes: next.preClaimScopes,
          postClaimScopes: next.postClaimScopes,
          resource: next.resource,
          audience: next.audience,
          claimEmailNormalized: next.claimEmailNormalized,
          assertionVersion: next.assertionVersion,
          providerIssuer: next.providerIssuer,
          providerSubject: next.providerSubject,
          providerClientId: next.providerClientId,
          version: expectedVersion + 1,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.agentRegistrations.id, next.id),
            eq(schema.agentRegistrations.version, expectedVersion),
          ),
        )
        .returning();
      if (!row) {
        throw new ConflictError(`agent registration cas failed: ${next.id}`);
      }
      return mapRegistration(row);
    },

    async expireDue(now) {
      const rows = await db
        .update(schema.agentRegistrations)
        .set({
          status: "expired",
          version: sql`${schema.agentRegistrations.version} + 1`,
          updatedAt: now,
        })
        .where(
          and(
            lte(schema.agentRegistrations.expiresAt, now),
            sql`${schema.agentRegistrations.status} in ('unclaimed','claim_pending')`,
          ),
        )
        .returning({ id: schema.agentRegistrations.id });
      return rows.length;
    },

    async createClaimAttempt(attempt, uow) {
      const conn = resolveDb(uow);
      const [row] = await conn
        .insert(schema.agentClaimAttempts)
        .values({
          id: attempt.id,
          registrationId: attempt.registrationId,
          attemptTokenDigest: attempt.attemptTokenDigest,
          userCodeDigest: attempt.userCodeDigest,
          emailNormalized: attempt.emailNormalized,
          createdAt: attempt.createdAt,
          expiresAt: attempt.expiresAt,
          intervalSeconds: attempt.intervalSeconds,
          slowdownUntil: attempt.slowdownUntil,
          pollCount: attempt.pollCount,
          failedAttempts: attempt.failedAttempts,
          completedAt: attempt.completedAt,
        })
        .returning();
      if (!row) throw new Error("failed to insert agent claim attempt");
      return mapAttempt(row);
    },

    async getClaimAttemptById(id) {
      const [row] = await db
        .select()
        .from(schema.agentClaimAttempts)
        .where(eq(schema.agentClaimAttempts.id, id))
        .limit(1);
      return row ? mapAttempt(row) : null;
    },

    async getClaimAttemptByTokenDigest(digest) {
      const [row] = await db
        .select()
        .from(schema.agentClaimAttempts)
        .where(eq(schema.agentClaimAttempts.attemptTokenDigest, digest))
        .limit(1);
      return row ? mapAttempt(row) : null;
    },

    async latestClaimAttempt(registrationId) {
      const [row] = await db
        .select()
        .from(schema.agentClaimAttempts)
        .where(eq(schema.agentClaimAttempts.registrationId, registrationId))
        .orderBy(desc(schema.agentClaimAttempts.createdAt))
        .limit(1);
      return row ? mapAttempt(row) : null;
    },

    async updateClaimAttempt(attempt, uow) {
      const conn = resolveDb(uow);
      const [row] = await conn
        .update(schema.agentClaimAttempts)
        .set({
          slowdownUntil: attempt.slowdownUntil,
          pollCount: attempt.pollCount,
          failedAttempts: attempt.failedAttempts,
          completedAt: attempt.completedAt,
        })
        .where(eq(schema.agentClaimAttempts.id, attempt.id))
        .returning();
      if (!row) {
        throw new ConflictError(`agent claim attempt missing: ${attempt.id}`);
      }
      return mapAttempt(row);
    },

    async createAccessToken(record, uow) {
      const conn = resolveDb(uow);
      const [row] = await conn
        .insert(schema.agentAccessTokens)
        .values({
          id: record.id,
          registrationId: record.registrationId,
          tokenDigest: record.tokenDigest,
          scopes: record.scopes,
          claimed: record.claimed,
          assertionVersion: record.assertionVersion,
          resource: record.resource,
          expiresAt: record.expiresAt,
          revokedAt: record.revokedAt,
          createdAt: record.createdAt,
        })
        .returning();
      if (!row) throw new Error("failed to insert agent access token");
      return mapAccess(row);
    },

    async getAccessTokenByDigest(digest) {
      const [row] = await db
        .select()
        .from(schema.agentAccessTokens)
        .where(eq(schema.agentAccessTokens.tokenDigest, digest))
        .limit(1);
      return row ? mapAccess(row) : null;
    },

    async revokeAccessToken(id, at, uow) {
      const conn = resolveDb(uow);
      await conn
        .update(schema.agentAccessTokens)
        .set({ revokedAt: at })
        .where(
          and(
            eq(schema.agentAccessTokens.id, id),
            isNull(schema.agentAccessTokens.revokedAt),
          ),
        );
    },

    async revokeAccessTokensForRegistration(
      registrationId,
      at,
      onlyUnclaimed,
      uow,
    ) {
      const conn = resolveDb(uow);
      const rows = await conn
        .update(schema.agentAccessTokens)
        .set({ revokedAt: at })
        .where(
          and(
            eq(schema.agentAccessTokens.registrationId, registrationId),
            isNull(schema.agentAccessTokens.revokedAt),
            onlyUnclaimed
              ? eq(schema.agentAccessTokens.claimed, false)
              : sql`true`,
          ),
        )
        .returning({ id: schema.agentAccessTokens.id });
      return rows.length;
    },

    async createAssertion(record, uow) {
      const conn = resolveDb(uow);
      const [row] = await conn
        .insert(schema.agentServiceAssertions)
        .values({
          jti: record.jti,
          registrationId: record.registrationId,
          assertionVersion: record.assertionVersion,
          expiresAt: record.expiresAt,
          revokedAt: record.revokedAt,
          createdAt: record.createdAt,
        })
        .returning();
      if (!row) throw new Error("failed to insert agent assertion");
      return mapAssertion(row);
    },

    async getAssertionByJti(jti) {
      const [row] = await db
        .select()
        .from(schema.agentServiceAssertions)
        .where(eq(schema.agentServiceAssertions.jti, jti))
        .limit(1);
      return row ? mapAssertion(row) : null;
    },

    async revokeAssertionsForRegistration(
      registrationId,
      at,
      belowVersion,
      uow,
    ) {
      const conn = resolveDb(uow);
      const rows = await conn
        .update(schema.agentServiceAssertions)
        .set({ revokedAt: at })
        .where(
          and(
            eq(schema.agentServiceAssertions.registrationId, registrationId),
            isNull(schema.agentServiceAssertions.revokedAt),
            belowVersion !== undefined
              ? sql`${schema.agentServiceAssertions.assertionVersion} < ${belowVersion}`
              : sql`true`,
          ),
        )
        .returning({ jti: schema.agentServiceAssertions.jti });
      return rows.length;
    },

    async countLiveRegistrations() {
      const rows = await db
        .select({ id: schema.agentRegistrations.id })
        .from(schema.agentRegistrations)
        .where(
          sql`${schema.agentRegistrations.status} in ('unclaimed','claim_pending')`,
        );
      return rows.length;
    },
  };
}

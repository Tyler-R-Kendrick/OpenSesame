import { randomUUID } from "node:crypto";
import type {
  AuditEvent,
  BetterAuthSubject,
  ClaimItem,
  ClaimSession,
  ExternalIdentity,
  OutboxEvent,
  Principal,
} from "@opensesame/os-domain";
import {
  ConflictError,
  NotFoundError,
  OUTBOX_CLAIM_HOLD_MS,
  type AuditEventRepository,
  type BetterAuthSubjectRepository,
  type ClaimItemRepository,
  type ClaimSessionRepository,
  type ExternalIdentityRepository,
  type NewOutboxEvent,
  type OutboxRepository,
  outboxClaimToken,
  outboxHoldActive,
  type PrincipalRepository,
  type Repositories,
  type TransactionFn,
  type UnitOfWork,
} from "./interfaces.js";

function normalizeTenant(tenant?: string): string {
  return tenant ?? "";
}

function identityKey(input: {
  kind: string;
  issuer: string;
  tenant?: string;
  subject: string;
}): string {
  return [
    input.kind,
    input.issuer,
    normalizeTenant(input.tenant),
    input.subject,
  ].join("\0");
}

function cloneBytes(value: Uint8Array): Uint8Array {
  return new Uint8Array(value);
}

function cloneClaim(session: ClaimSession): ClaimSession {
  // structuredClone matches the Postgres JSON round-trip: nested
  // reviewDecision / manifest objects must not share references with the store.
  return structuredClone(session);
}

type PendingOp = () => void;

class MemoryUnitOfWork implements UnitOfWork {
  readonly ops: PendingOp[] = [];
  readonly outboxBuffer: OutboxEvent[] = [];

  constructor(private readonly store: MemoryStore) {}

  async appendOutbox(event: NewOutboxEvent): Promise<OutboxEvent> {
    const row: OutboxEvent = {
      id: event.id || randomUUID(),
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      eventType: event.eventType,
      payload: { ...event.payload },
      createdAt: new Date(),
      availableAt: event.availableAt ?? new Date(),
      attempts: 0,
    };
    this.outboxBuffer.push(row);
    this.ops.push(() => {
      this.store.outbox.set(row.id, { ...row, payload: { ...row.payload } });
    });
    return row;
  }

  defer(op: PendingOp): void {
    this.ops.push(op);
  }

  commit(): void {
    for (const op of this.ops) {
      op();
    }
  }
}

class MemoryStore {
  principals = new Map<string, Principal>();
  identities = new Map<string, ExternalIdentity>();
  identityKeys = new Map<string, string>();
  betterAuth = new Map<string, BetterAuthSubject>();
  claims = new Map<string, ClaimSession>();
  claimItems = new Map<string, ClaimItem>();
  audit = new Map<string, AuditEvent>();
  outbox = new Map<string, OutboxEvent>();
}

function applyNowOrDefer(uow: UnitOfWork | undefined, apply: () => void) {
  if (uow instanceof MemoryUnitOfWork) {
    uow.defer(apply);
  } else {
    apply();
  }
}

export class MemoryRepositories implements Repositories {
  readonly #store = new MemoryStore();

  readonly principals: PrincipalRepository = {
    create: async (principal, uow) => {
      if (this.#store.principals.has(principal.id)) {
        throw new ConflictError(`principal already exists: ${principal.id}`);
      }
      const row: Principal = { ...principal };
      const apply = () => {
        this.#store.principals.set(row.id, { ...row });
      };
      applyNowOrDefer(uow, apply);
      return { ...row };
    },

    getById: async (id) => {
      const row = this.#store.principals.get(id);
      return row ? { ...row } : null;
    },

    update: async (id, patch, expectedVersion, uow) => {
      const current = this.#store.principals.get(id);
      if (!current) {
        throw new NotFoundError(`principal not found: ${id}`);
      }
      if (current.version !== expectedVersion) {
        throw new ConflictError(
          `principal version conflict: expected ${expectedVersion}, got ${current.version}`,
        );
      }
      const next: Principal = {
        ...current,
        ...patch,
        id: current.id,
        createdAt: current.createdAt,
        version: current.version + 1,
        updatedAt: patch.updatedAt ?? new Date(),
      };
      const apply = () => {
        this.#store.principals.set(id, { ...next });
      };
      applyNowOrDefer(uow, apply);
      return { ...next };
    },
  };

  readonly externalIdentities: ExternalIdentityRepository = {
    create: async (identity, uow) => {
      const key = identityKey(identity);
      if (this.#store.identityKeys.has(key)) {
        throw new ConflictError(
          `external identity collision for kind+issuer+tenant+subject`,
        );
      }
      if (this.#store.identities.has(identity.id)) {
        throw new ConflictError(
          `external identity already exists: ${identity.id}`,
        );
      }
      const tenant = normalizeTenant(identity.tenant);
      const row: ExternalIdentity = {
        ...identity,
        metadata: { ...identity.metadata },
        ...(tenant ? { tenant } : {}),
      };
      const apply = () => {
        this.#store.identities.set(row.id, {
          ...row,
          metadata: { ...row.metadata },
        });
        this.#store.identityKeys.set(key, row.id);
      };
      applyNowOrDefer(uow, apply);
      return { ...row, metadata: { ...row.metadata } };
    },

    getById: async (id) => {
      const row = this.#store.identities.get(id);
      return row ? { ...row, metadata: { ...row.metadata } } : null;
    },

    findByTuple: async (input) => {
      const id = this.#store.identityKeys.get(identityKey(input));
      if (!id) return null;
      const row = this.#store.identities.get(id);
      return row ? { ...row, metadata: { ...row.metadata } } : null;
    },

    listByPrincipal: async (principalId) => {
      return [...this.#store.identities.values()]
        .filter((row) => row.principalId === principalId)
        .map((row) => ({ ...row, metadata: { ...row.metadata } }));
    },

    listByEmailNormalized: async (email) => {
      return [...this.#store.identities.values()]
        .filter((row) => row.emailNormalized === email)
        .map((row) => ({ ...row, metadata: { ...row.metadata } }));
    },

    deleteById: async (id, uow) => {
      const row = this.#store.identities.get(id);
      if (!row) return false;
      const key = identityKey(row);
      const apply = () => {
        this.#store.identities.delete(id);
        this.#store.identityKeys.delete(key);
      };
      applyNowOrDefer(uow, apply);
      return true;
    },
  };

  readonly betterAuthSubjects: BetterAuthSubjectRepository = {
    link: async (row, uow) => {
      if (this.#store.betterAuth.has(row.betterAuthUserId)) {
        throw new ConflictError(
          `better auth subject already linked: ${row.betterAuthUserId}`,
        );
      }
      const next = { ...row };
      const apply = () => {
        this.#store.betterAuth.set(next.betterAuthUserId, { ...next });
      };
      applyNowOrDefer(uow, apply);
      return { ...next };
    },

    getByBetterAuthUserId: async (userId) => {
      const row = this.#store.betterAuth.get(userId);
      return row ? { ...row } : null;
    },
  };

  readonly claimSessions: ClaimSessionRepository = {
    create: async (session, uow) => {
      if (this.#store.claims.has(session.id)) {
        throw new ConflictError(`claim session already exists: ${session.id}`);
      }
      const row = cloneClaim(session);
      const apply = () => {
        this.#store.claims.set(row.id, cloneClaim(row));
      };
      applyNowOrDefer(uow, apply);
      return cloneClaim(row);
    },

    getById: async (id) => {
      const row = this.#store.claims.get(id);
      return row ? cloneClaim(row) : null;
    },

    updateWithVersion: async (id, expectedVersion, patch, uow) => {
      const current = this.#store.claims.get(id);
      if (!current) {
        throw new NotFoundError(`claim session not found: ${id}`);
      }
      if (current.version !== expectedVersion) {
        throw new ConflictError(
          `claim version conflict: expected ${expectedVersion}, got ${current.version}`,
        );
      }
      const merged: ClaimSession = {
        ...current,
        ...patch,
        id: current.id,
        createdAt: current.createdAt,
        version: current.version + 1,
        tokenDigest: patch.tokenDigest
          ? cloneBytes(patch.tokenDigest)
          : current.tokenDigest,
      };
      if (patch.userCodeDigest !== undefined) {
        if (patch.userCodeDigest) {
          merged.userCodeDigest = cloneBytes(patch.userCodeDigest);
        } else {
          delete merged.userCodeDigest;
        }
      }
      const next = cloneClaim(merged);
      const apply = () => {
        this.#store.claims.set(id, cloneClaim(next));
      };
      applyNowOrDefer(uow, apply);
      return cloneClaim(next);
    },
  };

  readonly claimItems: ClaimItemRepository = {
    create: async (item, uow) => {
      if (this.#store.claimItems.has(item.id)) {
        throw new ConflictError(`claim item already exists: ${item.id}`);
      }
      const row: ClaimItem = {
        ...item,
        dependencies: [...item.dependencies],
      };
      const apply = () => {
        this.#store.claimItems.set(row.id, {
          ...row,
          dependencies: [...row.dependencies],
        });
      };
      applyNowOrDefer(uow, apply);
      return { ...row, dependencies: [...row.dependencies] };
    },

    listByClaim: async (claimId) => {
      return [...this.#store.claimItems.values()]
        .filter((row) => row.claimId === claimId)
        .map((row) => ({ ...row, dependencies: [...row.dependencies] }));
    },
  };

  readonly auditEvents: AuditEventRepository = {
    append: async (event, uow) => {
      const row: AuditEvent = {
        ...event,
        metadata: { ...event.metadata },
      };
      const apply = () => {
        this.#store.audit.set(row.id, {
          ...row,
          metadata: { ...row.metadata },
        });
      };
      applyNowOrDefer(uow, apply);
      return { ...row, metadata: { ...row.metadata } };
    },
    list: async (filter) => {
      // Insertion order is append order, which is the order the hash chain was
      // built in. Sorting by `occurredAt` here put ties in arbitrary order and so
      // could not be re-walked.
      let rows = [...this.#store.audit.values()].reverse();
      if (filter?.principalId) {
        rows = rows.filter((r) => r.principalId === filter.principalId);
      }
      const limit = filter?.limit ?? 50;
      return rows.slice(0, limit).map((r) => ({
        ...r,
        metadata: { ...r.metadata },
      }));
    },
  };

  readonly outbox: OutboxRepository = {
    append: async (event, uow) => {
      if (uow instanceof MemoryUnitOfWork) {
        return uow.appendOutbox(event);
      }
      const row: OutboxEvent = {
        id: event.id || randomUUID(),
        aggregateType: event.aggregateType,
        aggregateId: event.aggregateId,
        eventType: event.eventType,
        payload: { ...event.payload },
        createdAt: new Date(),
        availableAt: event.availableAt ?? new Date(),
        attempts: 0,
      };
      this.#store.outbox.set(row.id, { ...row, payload: { ...row.payload } });
      return { ...row, payload: { ...row.payload } };
    },

    listUnpublished: async (limit = 100) => {
      const now = new Date();
      return [...this.#store.outbox.values()]
        .filter(
          (row) =>
            row.publishedAt === undefined && !outboxHoldActive(row.lastError, now),
        )
        .sort((a, b) => a.availableAt.getTime() - b.availableAt.getTime())
        .slice(0, limit)
        .map((row) => ({ ...row, payload: { ...row.payload } }));
    },

    claimUnpublished: async (limit = 100, now = new Date(), holdMs = OUTBOX_CLAIM_HOLD_MS) => {
      const claimed: OutboxEvent[] = [];
      const token = outboxClaimToken(now, holdMs);
      const rows = [...this.#store.outbox.values()]
        .filter(
          (row) =>
            row.publishedAt === undefined &&
            row.availableAt <= now &&
            !outboxHoldActive(row.lastError, now),
        )
        .sort((a, b) => a.availableAt.getTime() - b.availableAt.getTime())
        .slice(0, limit);
      for (const row of rows) {
        const next = {
          ...row,
          payload: { ...row.payload },
          attempts: row.attempts + 1,
          lastError: token,
        };
        this.#store.outbox.set(row.id, next);
        claimed.push({ ...next, payload: { ...next.payload } });
      }
      return claimed;
    },

    releaseClaim: async (id, error) => {
      const row = this.#store.outbox.get(id);
      if (!row || row.publishedAt !== undefined) return;
      this.#store.outbox.set(id, {
        ...row,
        payload: { ...row.payload },
        ...(error ? { lastError: error } : {}),
      });
      if (!error) {
        const next = { ...row, payload: { ...row.payload } };
        delete next.lastError;
        this.#store.outbox.set(id, next);
      }
    },

    markPublished: async (id, publishedAt = new Date()) => {
      const row = this.#store.outbox.get(id);
      if (!row) {
        throw new NotFoundError(`outbox event not found: ${id}`);
      }
      if (row.publishedAt !== undefined) return;
      this.#store.outbox.set(id, { ...row, publishedAt });
    },
  };

  async transaction<T>(fn: TransactionFn<T>): Promise<T> {
    const uow = new MemoryUnitOfWork(this.#store);
    const result = await fn(uow);
    uow.commit();
    return result;
  }
}

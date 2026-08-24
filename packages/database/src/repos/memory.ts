import { randomUUID } from "node:crypto";
import type {
  AuditEvent,
  AuthorizationRequest,
  BetterAuthSubject,
  ClaimItem,
  ClaimSession,
  ExternalIdentity,
  OutboxEvent,
  Principal,
  Project,
  ProjectMembership,
} from "@opensesame/os-domain";
import {
  type AuditEventRepository,
  type AuthorizationRequestRepository,
  type BetterAuthSubjectRepository,
  type ClaimItemRepository,
  type ClaimSessionRepository,
  ConflictError,
  type EnsurePersonalProjectResult,
  type ExternalIdentityRepository,
  type NewOutboxEvent,
  NotFoundError,
  OUTBOX_CLAIM_HOLD_MS,
  type OutboxRepository,
  type PrincipalRepository,
  type ProjectMembershipStore,
  type ProjectStore,
  type ProjectStores,
  type Repositories,
  type TransactionFn,
  type UnitOfWork,
  buildPersonalProject,
  outboxClaimToken,
  outboxHoldActive,
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

function cloneAuthorizationRequest(
  request: AuthorizationRequest,
): AuthorizationRequest {
  // Same reason as cloneClaim: authorizationDetails is nested JSON, and the
  // Postgres implementation round-trips it. A shallow copy would let a caller
  // mutate a stored row here and not there.
  return structuredClone(request);
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
  authorizationRequests = new Map<string, AuthorizationRequest>();
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
    deleteUnlinkedProvisional: async (id, uow) => {
      const row = this.#store.principals.get(id);
      if (!row || row.state !== "provisional") return false;
      if (
        [...this.#store.identities.values()].some(
          (item) => item.principalId === id,
        )
      ) {
        return false;
      }
      const apply = () => {
        this.#store.principals.delete(id);
        for (const [key, subject] of this.#store.betterAuth) {
          if (subject.principalId === id) this.#store.betterAuth.delete(key);
        }
      };
      applyNowOrDefer(uow, apply);
      return true;
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
          "external identity collision for kind+issuer+tenant+subject",
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
        ...(tenant ? { tenant } : undefined),
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

  readonly authorizationRequests: AuthorizationRequestRepository = {
    create: async (request, uow) => {
      if (this.#store.authorizationRequests.has(request.id)) {
        throw new ConflictError(
          `authorization request already exists: ${request.id}`,
        );
      }
      const row = cloneAuthorizationRequest(request);
      const apply = () => {
        this.#store.authorizationRequests.set(
          row.id,
          cloneAuthorizationRequest(row),
        );
      };
      applyNowOrDefer(uow, apply);
      return cloneAuthorizationRequest(row);
    },

    getById: async (id) => {
      const row = this.#store.authorizationRequests.get(id);
      return row ? cloneAuthorizationRequest(row) : null;
    },

    listForPrincipal: async (principalId, filter) => {
      const rows = [...this.#store.authorizationRequests.values()]
        .filter((row) => row.principalId === principalId)
        .filter((row) => !filter?.status || row.status === filter.status)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      return rows
        .slice(0, filter?.limit ?? 50)
        .map((row) => cloneAuthorizationRequest(row));
    },

    updateWithVersion: async (id, expectedVersion, patch, uow) => {
      const current = this.#store.authorizationRequests.get(id);
      if (!current) {
        throw new NotFoundError(`authorization request not found: ${id}`);
      }
      if (current.version !== expectedVersion) {
        throw new ConflictError(
          `authorization request version conflict: expected ${expectedVersion}, got ${current.version}`,
        );
      }
      const merged: AuthorizationRequest = {
        ...current,
        ...patch,
        id: current.id,
        createdAt: current.createdAt,
        version: current.version + 1,
      };
      const apply = () => {
        this.#store.authorizationRequests.set(
          id,
          cloneAuthorizationRequest(merged),
        );
      };
      applyNowOrDefer(uow, apply);
      return cloneAuthorizationRequest(merged);
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
          Reflect.deleteProperty(merged, "userCodeDigest");
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
            row.publishedAt === undefined &&
            !outboxHoldActive(row.lastError, now),
        )
        .sort((a, b) => a.availableAt.getTime() - b.availableAt.getTime())
        .slice(0, limit)
        .map((row) => ({ ...row, payload: { ...row.payload } }));
    },

    claimUnpublished: async (
      limit = 100,
      now = new Date(),
      holdMs = OUTBOX_CLAIM_HOLD_MS,
    ) => {
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
        ...(error ? { lastError: error } : undefined),
      });
      if (!error) {
        const next = { ...row, payload: { ...row.payload } };
        Reflect.deleteProperty(next, "lastError");
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

function membershipKey(projectId: string, principalId: string): string {
  return `${projectId}:${principalId}`;
}

/**
 * In-memory membership store — the Map the control plane used to hold in
 * `AppStores`, promoted to the store interface. It deliberately *extends* Map
 * keyed by `${projectId}:${principalId}` so existing tests that seed rows via
 * `store.set(key, membership)` keep observing the same state the interface
 * methods read.
 */
export class MemoryProjectMembershipStore
  extends Map<string, ProjectMembership>
  implements ProjectMembershipStore
{
  find(projectId: string, principalId: string): ProjectMembership | undefined {
    return super.get(membershipKey(projectId, principalId));
  }

  upsert(membership: ProjectMembership): ProjectMembership {
    this.set(
      membershipKey(membership.projectId, membership.principalId),
      membership,
    );
    return membership;
  }

  remove(projectId: string, principalId: string): boolean {
    return this.delete(membershipKey(projectId, principalId));
  }

  removeByProject(projectId: string): number {
    let removed = 0;
    for (const [key, membership] of this) {
      if (membership.projectId === projectId) {
        this.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  listByProject(projectId: string): ProjectMembership[] {
    return [...this.values()].filter((m) => m.projectId === projectId);
  }

  listByPrincipal(principalId: string): ProjectMembership[] {
    return [...this.values()].filter((m) => m.principalId === principalId);
  }

  countOwners(projectId: string): number {
    let count = 0;
    for (const membership of this.values()) {
      if (membership.projectId === projectId && membership.role === "owner") {
        count += 1;
      }
    }
    return count;
  }
}

/**
 * In-memory project store — the former `AppStores.projects` Map behind the
 * store interface. Extends Map keyed by project id for the same test-seeding
 * reason as {@link MemoryProjectMembershipStore}; `get`/`set` keep their Map
 * semantics and double as the interface's read/upsert.
 */
export class MemoryProjectStore
  extends Map<string, Project>
  implements ProjectStore
{
  constructor(private readonly memberships: ProjectMembershipStore) {
    super();
  }

  override set(id: string, project: Project): this;
  override set(id: string, project: Project): void;
  override set(id: string, project: Project): this {
    return super.set(id, project);
  }

  listByOwner(ownerPrincipalId: string): Project[] {
    return [...this.values()].filter(
      (p) => p.ownerPrincipalId === ownerPrincipalId,
    );
  }

  findPersonalByOwner(ownerPrincipalId: string): Project | undefined {
    for (const project of this.values()) {
      if (
        project.kind === "personal" &&
        project.ownerPrincipalId === ownerPrincipalId &&
        project.state !== "deleted" &&
        project.state !== "deleting"
      ) {
        return project;
      }
    }
    return undefined;
  }

  async ensurePersonal(
    principalId: string,
    organizationId?: string,
    now: Date = new Date(),
  ): Promise<EnsurePersonalProjectResult> {
    const existing = this.findPersonalByOwner(principalId);
    if (existing) {
      return { project: existing, created: false };
    }
    const project = buildPersonalProject(principalId, now, organizationId);
    this.set(project.id, project);
    await this.memberships.upsert({
      projectId: project.id,
      principalId,
      role: "owner",
      createdAt: now,
      updatedAt: now,
    });
    return { project, created: true };
  }
}

/**
 * The linked pair: `projects.ensurePersonal` mints the owner membership.
 * Returns the concrete classes (a narrowing of {@link ProjectStores}) so
 * Map-level seeding in tests stays typed.
 */
export function createMemoryProjectStores(): ProjectStores & {
  projects: MemoryProjectStore;
  projectMemberships: MemoryProjectMembershipStore;
} {
  const projectMemberships = new MemoryProjectMembershipStore();
  return {
    projects: new MemoryProjectStore(projectMemberships),
    projectMemberships,
  };
}

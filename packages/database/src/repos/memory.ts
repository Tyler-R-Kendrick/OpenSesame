import { randomUUID } from "node:crypto";
import type {
  AuditEvent,
  AuthorizationRequest,
  BetterAuthSubject,
  ByoUpstream,
  ClaimItem,
  ClaimSession,
  ExternalIdentity,
  Organization,
  OrganizationMembership,
  OutboxEvent,
  Principal,
  Project,
  ProjectMembership,
  WebhookDelivery,
  WebhookEndpoint,
} from "@opensesame/os-domain";
import {
  type AuditEventRepository,
  type AuthorizationRequestRepository,
  type BetterAuthSubjectRepository,
  type ByoUpstreamRepository,
  type ClaimItemRepository,
  type ClaimSessionRepository,
  ConflictError,
  type EnsurePersonalProjectResult,
  type ExternalIdentityRepository,
  type NewOutboxEvent,
  NotFoundError,
  OUTBOX_CLAIM_HOLD_MS,
  type OrganizationMembershipStore,
  type OrganizationStore,
  type OrganizationStores,
  type OutboxRepository,
  type PrincipalRepository,
  type ProjectMembershipStore,
  type ProjectStore,
  type ProjectStores,
  type Repositories,
  type TransactionFn,
  type UnitOfWork,
  type WebhookDeliveryRepository,
  type WebhookEndpointRepository,
  buildPersonalProject,
  normalizeIssuer,
  normalizeOrganizationRow,
  organizationClaimsIssuer,
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

/**
 * A row the verified-email auto-link may attach to (ADR 0057): the identity's
 * own assurance is `verified` and its email is not explicitly unverified.
 */
function verifiedEmailCandidate(
  row: ExternalIdentity,
  emailNormalized: string,
): boolean {
  return (
    row.emailNormalized === emailNormalized &&
    row.assurance === "verified" &&
    // Explicitly true, never merely not-false — see the Postgres predicate.
    // An absent flag means nobody checked the address, and a link target
    // nobody checked is a way onto somebody else's principal.
    row.emailVerified === true
  );
}

/** Oldest owning principal first, then principal id, then identity id (T32). */
function compareVerifiedEmailOwners(
  a: { row: ExternalIdentity; owner: Principal },
  b: { row: ExternalIdentity; owner: Principal },
): number {
  const byAge = a.owner.createdAt.getTime() - b.owner.createdAt.getTime();
  if (byAge !== 0) return byAge;
  if (a.row.principalId !== b.row.principalId) {
    return a.row.principalId < b.row.principalId ? -1 : 1;
  }
  if (a.row.id === b.row.id) return 0;
  return a.row.id < b.row.id ? -1 : 1;
}

function cloneByoUpstream(record: ByoUpstream): ByoUpstream {
  return { ...record };
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
  byoUpstreams = new Map<string, ByoUpstream>();
  identityKeys = new Map<string, string>();
  betterAuth = new Map<string, BetterAuthSubject>();
  claims = new Map<string, ClaimSession>();
  claimItems = new Map<string, ClaimItem>();
  audit = new Map<string, AuditEvent>();
  outbox = new Map<string, OutboxEvent>();
  authorizationRequests = new Map<string, AuthorizationRequest>();
  webhookEndpoints = new Map<string, WebhookEndpoint>();
  webhookDeliveries = new Map<string, WebhookDelivery>();
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

    findVerifiedByEmail: async (emailNormalized) => {
      const owned = [...this.#store.identities.values()]
        .filter((row) => verifiedEmailCandidate(row, emailNormalized))
        .flatMap((row) => {
          // Inner-join semantics: Postgres reaches the owner through the FK,
          // so an identity with no principal is no candidate here either.
          const owner = this.#store.principals.get(row.principalId);
          return owner ? [{ row, owner }] : [];
        })
        .sort((a, b) => compareVerifiedEmailOwners(a, b));
      const best = owned[0];
      return best ? { ...best.row, metadata: { ...best.row.metadata } } : null;
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

  readonly byoUpstreams: ByoUpstreamRepository = {
    create: async (record) => {
      const issuer = normalizeIssuer(record.issuer);
      if (this.#store.byoUpstreams.has(record.id)) {
        throw new ConflictError(`byo upstream already exists: ${record.id}`);
      }
      for (const existing of this.#store.byoUpstreams.values()) {
        if (existing.issuer === issuer) {
          throw new ConflictError(
            `byo upstream issuer already registered: ${issuer}`,
          );
        }
      }
      const row: ByoUpstream = { ...record, issuer };
      this.#store.byoUpstreams.set(row.id, cloneByoUpstream(row));
      return cloneByoUpstream(row);
    },

    getById: async (id) => {
      const row = this.#store.byoUpstreams.get(id);
      return row ? cloneByoUpstream(row) : null;
    },

    findByIssuer: async (issuer) => {
      const target = normalizeIssuer(issuer);
      for (const row of this.#store.byoUpstreams.values()) {
        if (row.issuer === target) return cloneByoUpstream(row);
      }
      return null;
    },

    touchLastUsed: async (id, at) => {
      const row = this.#store.byoUpstreams.get(id);
      if (!row) return;
      this.#store.byoUpstreams.set(id, { ...row, lastUsedAt: at });
    },

    list: async () => {
      return [...this.#store.byoUpstreams.values()]
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .map(cloneByoUpstream);
    },

    setState: async (id, state) => {
      const row = this.#store.byoUpstreams.get(id);
      if (!row) return null;
      const next: ByoUpstream = { ...row, state };
      this.#store.byoUpstreams.set(id, next);
      return cloneByoUpstream(next);
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

  readonly webhookEndpoints: WebhookEndpointRepository = {
    create: async (endpoint, uow) => {
      if (this.#store.webhookEndpoints.has(endpoint.id)) {
        throw new ConflictError(
          `webhook endpoint already exists: ${endpoint.id}`,
        );
      }
      const row: WebhookEndpoint = { ...endpoint };
      applyNowOrDefer(uow, () => {
        this.#store.webhookEndpoints.set(row.id, { ...row });
      });
      return { ...row };
    },

    getById: async (id) => {
      const row = this.#store.webhookEndpoints.get(id);
      return row ? { ...row } : null;
    },

    listForPrincipal: async (principalId) => {
      return [...this.#store.webhookEndpoints.values()]
        .filter(
          (row) =>
            row.principalId === principalId && row.disabledAt === undefined,
        )
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .map((row) => ({ ...row }));
    },

    deleteById: async (id, uow) => {
      const existed = this.#store.webhookEndpoints.has(id);
      applyNowOrDefer(uow, () => {
        this.#store.webhookEndpoints.delete(id);
        // Cascade, as Postgres does: deliveries for a gone endpoint are noise.
        for (const [deliveryId, delivery] of this.#store.webhookDeliveries) {
          if (delivery.endpointId === id) {
            this.#store.webhookDeliveries.delete(deliveryId);
          }
        }
      });
      return existed;
    },
  };

  readonly webhookDeliveries: WebhookDeliveryRepository = {
    enqueue: async (delivery, uow) => {
      // structuredClone for the same reason as cloneAuthorizationRequest:
      // payload is nested JSON and Postgres round-trips it.
      const row = structuredClone(delivery);
      applyNowOrDefer(uow, () => {
        this.#store.webhookDeliveries.set(row.id, structuredClone(row));
      });
      return structuredClone(row);
    },

    claimDue: async (limit, now) => {
      const due = [...this.#store.webhookDeliveries.values()]
        .filter(
          (row) =>
            row.deliveredAt === undefined &&
            row.deadAt === undefined &&
            row.nextAttemptAt <= now,
        )
        .sort((a, b) => a.nextAttemptAt.getTime() - b.nextAttemptAt.getTime())
        .slice(0, limit);
      const claimed: WebhookDelivery[] = [];
      for (const row of due) {
        const next = structuredClone(row);
        next.attempts = row.attempts + 1;
        this.#store.webhookDeliveries.set(row.id, structuredClone(next));
        claimed.push(next);
      }
      return claimed;
    },

    markDelivered: async (id, at) => {
      const row = this.#store.webhookDeliveries.get(id);
      if (!row) {
        throw new NotFoundError(`webhook delivery not found: ${id}`);
      }
      this.#store.webhookDeliveries.set(id, {
        ...structuredClone(row),
        deliveredAt: at,
      });
    },

    recordFailure: async (id, error, nextAttemptAt, dead) => {
      const row = this.#store.webhookDeliveries.get(id);
      if (!row) {
        throw new NotFoundError(`webhook delivery not found: ${id}`);
      }
      this.#store.webhookDeliveries.set(id, {
        ...structuredClone(row),
        lastError: error,
        nextAttemptAt,
        ...(dead ? { deadAt: nextAttemptAt } : undefined),
      });
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

function organizationMembershipKey(
  organizationId: string,
  principalId: string,
): string {
  return `${organizationId}:${principalId}`;
}

/**
 * In-memory organization membership store — the Map the control plane held in
 * `AppStores`, promoted to the store interface. It extends Map keyed by
 * `${organizationId}:${principalId}` for the same reason as
 * {@link MemoryProjectMembershipStore}: rows seeded through the Map API stay
 * visible to the interface reads.
 */
export class MemoryOrganizationMembershipStore
  extends Map<string, OrganizationMembership>
  implements OrganizationMembershipStore
{
  find(
    organizationId: string,
    principalId: string,
  ): OrganizationMembership | undefined {
    return super.get(organizationMembershipKey(organizationId, principalId));
  }

  upsert(membership: OrganizationMembership): OrganizationMembership {
    this.set(
      organizationMembershipKey(
        membership.organizationId,
        membership.principalId,
      ),
      membership,
    );
    return membership;
  }

  remove(organizationId: string, principalId: string): boolean {
    return this.delete(organizationMembershipKey(organizationId, principalId));
  }

  listByOrganization(organizationId: string): OrganizationMembership[] {
    return [...this.values()].filter(
      (m) => m.organizationId === organizationId,
    );
  }

  listByPrincipal(principalId: string): OrganizationMembership[] {
    return [...this.values()].filter((m) => m.principalId === principalId);
  }

  countOwners(organizationId: string): number {
    let count = 0;
    for (const membership of this.values()) {
      if (
        membership.organizationId === organizationId &&
        membership.role === "owner"
      ) {
        count += 1;
      }
    }
    return count;
  }
}

/**
 * In-memory organization store — the former `AppStores.organizations` Map
 * behind the store interface, with `organizationSlugs` folded into
 * {@link MemoryOrganizationStore.getBySlug} (a second Map could disagree with
 * the first; a scan cannot).
 *
 * `set` normalizes the row so an optional field left empty reads back absent,
 * exactly as a Postgres NULL does.
 */
export class MemoryOrganizationStore
  extends Map<string, Organization>
  implements OrganizationStore
{
  override set(id: string, organization: Organization): this;
  override set(id: string, organization: Organization): void;
  override set(id: string, organization: Organization): this {
    return super.set(id, normalizeOrganizationRow({ ...organization, id }));
  }

  getBySlug(slug: string): Organization | undefined {
    for (const organization of this.values()) {
      if (organization.slug === slug) return organization;
    }
    return undefined;
  }

  findByIssuer(issuer: string): Organization | undefined {
    for (const organization of this.values()) {
      if (organizationClaimsIssuer(organization, issuer)) return organization;
    }
    return undefined;
  }

  listByCreator(principalId: string): Organization[] {
    return [...this.values()].filter((org) => org.createdBy === principalId);
  }
}

/** The organization pair, mirroring {@link createMemoryProjectStores}. */
export function createMemoryOrganizationStores(): OrganizationStores & {
  organizations: MemoryOrganizationStore;
  organizationMemberships: MemoryOrganizationMembershipStore;
} {
  return {
    organizations: new MemoryOrganizationStore(),
    organizationMemberships: new MemoryOrganizationMembershipStore(),
  };
}

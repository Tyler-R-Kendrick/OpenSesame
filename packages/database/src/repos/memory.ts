import { randomUUID } from "node:crypto";
import type {
  ApprovalActivation,
  ApprovalReceipt,
  AuditEvent,
  AuthorizationRequest,
  BetterAuthSubject,
  ByoUpstream,
  CallbackReplayRecord,
  ClaimItem,
  ClaimSession,
  ComparisonChallenge,
  ExternalChannelBinding,
  ExternalIdentity,
  Interaction,
  InteractionKind,
  InteractionStatus,
  NotificationDelivery,
  NotificationPreferences,
  Organization,
  OrganizationMembership,
  OutboxEvent,
  Principal,
  Project,
  ProjectMembership,
  WebhookDelivery,
  WebhookEndpoint,
} from "@opensesame/os-domain";
import { interactionMachine } from "@opensesame/os-domain";
import {
  type ApprovalActivationRepository,
  type ApprovalReceiptRepository,
  type AuditEventRepository,
  type AuthorizationRequestRepository,
  type BetterAuthSubjectRepository,
  type ByoUpstreamRepository,
  type CallbackReplayRepository,
  type ChannelBindingChallenge,
  type ChannelBindingChallengeRepository,
  type ChannelBindingRepository,
  type ClaimItemRepository,
  type ClaimSessionRepository,
  type ComparisonChallengeRepository,
  ConflictError,
  type EnsurePersonalProjectResult,
  type ExternalIdentityRepository,
  type InteractionRepository,
  type NewOutboxEvent,
  NotFoundError,
  type NotificationDeliveryRepository,
  type NotificationPreferenceRepository,
  OUTBOX_CLAIM_HOLD_MS,
  type OrganizationMembershipStore,
  type OrganizationStore,
  type OrganizationStores,
  type OutboxRepository,
  type PrincipalRepository,
  type ProjectMembershipStore,
  type ProjectStore,
  type ProjectStores,
  type PushSubscription,
  type PushSubscriptionRepository,
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
import { MemoryAgentAuthRepository } from "./agent-auth-repo.js";

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

function cloneInteraction(interaction: Interaction): Interaction {
  // structuredClone rather than a spread: `subject`, `authorizationDetails`,
  // `assuranceRequired` and `approvalProof` are nested, and the Postgres
  // implementation round-trips all four through jsonb. A shallow copy would
  // let a caller mutate a stored row here and not there, which is the kind of
  // divergence a test suite passes straight through.
  return structuredClone(interaction);
}

/**
 * The live interaction over one ceremony, if any.
 *
 * "Live" is `machines/interaction.ts`'s own definition, read from the machine
 * rather than restated: a second copy of the terminal set is a second thing to
 * get out of step with the first.
 */
function liveInteractionForSubject(
  rows: Iterable<Interaction>,
  subjectKind: InteractionKind,
  subjectId: string,
): Interaction | undefined {
  for (const row of rows) {
    if (
      row.subject.kind === subjectKind &&
      row.subject.subjectId === subjectId &&
      !interactionMachine.isTerminal(row.status)
    ) {
      return row;
    }
  }
  return undefined;
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

/**
 * structuredClone, not a spread: `metadata` is nested JSON and the Postgres
 * implementation round-trips it through jsonb. A shallow copy would let a
 * caller mutate a stored row here and not there.
 */
function cloneChannelBinding(
  binding: ExternalChannelBinding,
): ExternalChannelBinding {
  return structuredClone(binding);
}

/** Flat row — every field is a scalar or a Date, so a spread is a full copy. */
function cloneBindingChallenge(
  challenge: ChannelBindingChallenge,
): ChannelBindingChallenge {
  return { ...challenge };
}

/** `byClass` is a nested object of per-class preferences; see cloneChannelBinding. */
function cloneNotificationPreferences(
  preferences: NotificationPreferences,
): NotificationPreferences {
  return structuredClone(preferences);
}

/** `payload` is nested JSON round-tripped through jsonb; see cloneChannelBinding. */
function cloneNotificationDelivery(
  delivery: NotificationDelivery,
): NotificationDelivery {
  return structuredClone(delivery);
}

/** Flat row — see cloneBindingChallenge. */
function cloneActivation(activation: ApprovalActivation): ApprovalActivation {
  return { ...activation };
}

/** Flat row — see cloneBindingChallenge. */
function cloneComparison(challenge: ComparisonChallenge): ComparisonChallenge {
  return { ...challenge };
}

/** The assurance/evidence arrays are nested; see cloneChannelBinding. */
function cloneReceipt(receipt: ApprovalReceipt): ApprovalReceipt {
  return structuredClone(receipt);
}

/** Flat row — see cloneBindingChallenge. */
function cloneReplay(record: CallbackReplayRecord): CallbackReplayRecord {
  return { ...record };
}

/** Flat row — see cloneBindingChallenge. */
function clonePushSubscription(sub: PushSubscription): PushSubscription {
  return { ...sub };
}

/**
 * The idempotence key Postgres computes as a generated column:
 * `coalesce(binding_id, endpoint_id, '')`. Derived in exactly one place here
 * too, so the two implementations cannot disagree about what "the same
 * destination" means.
 */
function deliveryDestinationId(delivery: NotificationDelivery): string {
  return delivery.bindingId ?? delivery.endpointId ?? "";
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
  interactions = new Map<string, Interaction>();
  webhookEndpoints = new Map<string, WebhookEndpoint>();
  webhookDeliveries = new Map<string, WebhookDelivery>();
  channelBindings = new Map<string, ExternalChannelBinding>();
  channelBindingChallenges = new Map<string, ChannelBindingChallenge>();
  /** Keyed by principal: one preference row per person, as the PK says. */
  notificationPreferences = new Map<string, NotificationPreferences>();
  notificationDeliveries = new Map<string, NotificationDelivery>();
  approvalActivations = new Map<string, ApprovalActivation>();
  /**
   * Keyed by `authReqId`, which is the column Postgres holds unique. Keying by
   * the id and indexing the request separately would let the two disagree; a
   * Map keyed by the unique column cannot.
   */
  comparisonChallenges = new Map<string, ComparisonChallenge>();
  /** Keyed by `authReqId` — one decision per request; see comparisonChallenges. */
  approvalReceipts = new Map<string, ApprovalReceipt>();
  callbackReplays = new Map<string, CallbackReplayRecord>();
  pushSubscriptions = new Map<string, PushSubscription>();
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
  readonly agentAuth = new MemoryAgentAuthRepository();

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
        // Hand-rolled equivalent of the `on delete cascade` the principal FK
        // carries in Postgres. A destination or a half-finished binding
        // ceremony that outlived its principal is a live route to a person
        // who no longer exists.
        for (const [key, row] of this.#store.channelBindings) {
          if (row.principalId === id) this.#store.channelBindings.delete(key);
        }
        for (const [key, row] of this.#store.channelBindingChallenges) {
          if (row.principalId === id) {
            this.#store.channelBindingChallenges.delete(key);
          }
        }
        this.#store.notificationPreferences.delete(id);
        for (const [key, row] of this.#store.notificationDeliveries) {
          if (row.principalId === id) {
            this.#store.notificationDeliveries.delete(key);
          }
        }
        for (const [key, row] of this.#store.approvalActivations) {
          if (row.principalId === id) {
            this.#store.approvalActivations.delete(key);
          }
        }
        for (const [key, row] of this.#store.pushSubscriptions) {
          if (row.principalId === id) {
            this.#store.pushSubscriptions.delete(key);
          }
        }
        // Receipts are deliberately NOT cascaded: `approval_receipts` carries
        // no FK, because the record of why something was allowed has to
        // survive the deletion of everything it names.
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

  readonly interactions: InteractionRepository = {
    create: async (interaction, uow) => {
      if (this.#store.interactions.has(interaction.id)) {
        throw new ConflictError(
          `interaction already exists: ${interaction.id}`,
        );
      }
      // Mirrors `interactions_live_subject_idx`. Postgres enforces one live
      // envelope per ceremony with a partial unique index; a memory store that
      // let a second one through would green-light the exact write the
      // database rejects — two QR codes addressing one device-authorization
      // session, one of which the initiator never saw.
      if (
        !interactionMachine.isTerminal(interaction.status) &&
        liveInteractionForSubject(
          this.#store.interactions.values(),
          interaction.subject.kind,
          interaction.subject.subjectId,
        )
      ) {
        throw new ConflictError(
          `interaction already live for subject: ${interaction.subject.kind}/${interaction.subject.subjectId}`,
        );
      }
      const row = cloneInteraction(interaction);
      const apply = () => {
        this.#store.interactions.set(row.id, cloneInteraction(row));
      };
      applyNowOrDefer(uow, apply);
      return cloneInteraction(row);
    },

    getById: async (id) => {
      const row = this.#store.interactions.get(id);
      return row ? cloneInteraction(row) : null;
    },

    getBySubject: async (subjectKind, subjectId) => {
      const row = liveInteractionForSubject(
        this.#store.interactions.values(),
        subjectKind,
        subjectId,
      );
      return row ? cloneInteraction(row) : null;
    },

    listForApprover: async (principalId, filter) => {
      const rows = [...this.#store.interactions.values()]
        .filter((row) => row.approverPrincipalId === principalId)
        .filter((row) => !filter?.status || row.status === filter.status)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      return rows.slice(0, filter?.limit ?? 50).map(cloneInteraction);
    },

    updateWithVersion: async (id, expectedVersion, patch, uow) => {
      const current = this.#store.interactions.get(id);
      if (!current) {
        throw new NotFoundError(`interaction not found: ${id}`);
      }
      if (current.version !== expectedVersion) {
        throw new ConflictError(
          `interaction version conflict: expected ${expectedVersion}, got ${current.version}`,
        );
      }
      // Field by field rather than `...patch`, mirroring the explicit `set()`
      // the Postgres implementation writes. A spread would apply whatever a
      // JavaScript caller handed over — including the consented-to fields the
      // patch type forbids — and the two stores would then disagree about
      // whether a settled interaction can be rewritten, with only the one
      // nobody runs tests against enforcing it.
      const merged: Interaction = { ...current, version: current.version + 1 };
      if (patch.status !== undefined) merged.status = patch.status;
      if (patch.approverPrincipalId !== undefined) {
        merged.approverPrincipalId = patch.approverPrincipalId;
      }
      if (patch.approvalProof !== undefined) {
        merged.approvalProof = patch.approvalProof;
      }
      if (patch.presentedAt !== undefined)
        merged.presentedAt = patch.presentedAt;
      if (patch.decidedAt !== undefined) merged.decidedAt = patch.decidedAt;
      if (patch.consumedAt !== undefined) merged.consumedAt = patch.consumedAt;
      if (patch.revokedAt !== undefined) merged.revokedAt = patch.revokedAt;
      // The partial unique index applies to updates too, so a patch that
      // brings a row back into the live set has to lose to whoever holds the
      // slot. Without this a settled envelope could be reopened alongside the
      // replacement that was issued after it settled.
      if (!interactionMachine.isTerminal(merged.status)) {
        const holder = liveInteractionForSubject(
          this.#store.interactions.values(),
          merged.subject.kind,
          merged.subject.subjectId,
        );
        if (holder && holder.id !== merged.id) {
          throw new ConflictError(
            `interaction already live for subject: ${merged.subject.kind}/${merged.subject.subjectId}`,
          );
        }
      }
      const apply = () => {
        this.#store.interactions.set(id, cloneInteraction(merged));
      };
      applyNowOrDefer(uow, apply);
      return cloneInteraction(merged);
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
      if (filter?.clientId) {
        rows = rows.filter((r) => r.clientId === filter.clientId);
      }
      if (filter?.organizationId) {
        rows = rows.filter((r) => r.organizationId === filter.organizationId);
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

  readonly channelBindings: ChannelBindingRepository = {
    create: async (binding, uow) => {
      if (this.#store.channelBindings.has(binding.id)) {
        throw new ConflictError(
          `channel binding already exists: ${binding.id}`,
        );
      }
      if (binding.providerSubjectId === "") {
        // Mirrors `channel_bindings_provider_subject_id_check`. An empty
        // subject is not an identity, and a row holding one is a row every
        // caller who sends nothing would match.
        throw new Error(
          "channel binding provider subject id must not be empty",
        );
      }
      for (const existing of this.#store.channelBindings.values()) {
        if (
          existing.kind === binding.kind &&
          existing.providerId === binding.providerId &&
          existing.providerTenantId === binding.providerTenantId &&
          existing.providerSubjectId === binding.providerSubjectId
        ) {
          throw new ConflictError(
            "channel binding collision for kind+provider+tenant+subject",
          );
        }
      }
      const row = cloneChannelBinding(binding);
      applyNowOrDefer(uow, () => {
        this.#store.channelBindings.set(row.id, cloneChannelBinding(row));
      });
      return cloneChannelBinding(row);
    },

    getById: async (id) => {
      const row = this.#store.channelBindings.get(id);
      return row ? cloneChannelBinding(row) : null;
    },

    listForPrincipal: async (principalId) => {
      return [...this.#store.channelBindings.values()]
        .filter((row) => row.principalId === principalId)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .map(cloneChannelBinding);
    },

    findByProviderIdentity: async (
      kind,
      providerId,
      providerTenantId,
      providerSubjectId,
    ) => {
      // All four components, and a non-empty subject. Subject ids are unique
      // within a provider tenant and not across them, so matching on fewer
      // lets a caller who controls their own workspace mint an identity that
      // resolves to somebody else's binding.
      if (providerSubjectId === "") return null;
      for (const row of this.#store.channelBindings.values()) {
        if (
          row.kind === kind &&
          row.providerId === providerId &&
          row.providerTenantId === providerTenantId &&
          row.providerSubjectId === providerSubjectId
        ) {
          return cloneChannelBinding(row);
        }
      }
      return null;
    },

    updateWithVersion: async (id, expectedVersion, patch, uow) => {
      const current = this.#store.channelBindings.get(id);
      if (!current) {
        throw new NotFoundError(`channel binding not found: ${id}`);
      }
      if (current.version !== expectedVersion) {
        throw new ConflictError(
          `channel binding version conflict: expected ${expectedVersion}, got ${current.version}`,
        );
      }
      const merged: ExternalChannelBinding = {
        ...current,
        ...patch,
        id: current.id,
        createdAt: current.createdAt,
        version: current.version + 1,
      };
      applyNowOrDefer(uow, () => {
        this.#store.channelBindings.set(id, cloneChannelBinding(merged));
      });
      return cloneChannelBinding(merged);
    },
  };

  readonly channelBindingChallenges: ChannelBindingChallengeRepository = {
    create: async (challenge, uow) => {
      if (this.#store.channelBindingChallenges.has(challenge.id)) {
        throw new ConflictError(
          `channel binding challenge already exists: ${challenge.id}`,
        );
      }
      const row = cloneBindingChallenge(challenge);
      applyNowOrDefer(uow, () => {
        this.#store.channelBindingChallenges.set(
          row.id,
          cloneBindingChallenge(row),
        );
      });
      return cloneBindingChallenge(row);
    },

    getById: async (id) => {
      const row = this.#store.channelBindingChallenges.get(id);
      return row ? cloneBindingChallenge(row) : null;
    },

    consumeAttempt: async (id, now) => {
      const current = this.#store.channelBindingChallenges.get(id);
      if (!current) return null;
      if (current.completedAt) return null;
      if (current.expiresAt.getTime() <= now.getTime()) return null;
      if (current.attempts >= current.maxAttempts) return null;
      const next: ChannelBindingChallenge = {
        ...current,
        attempts: current.attempts + 1,
        version: current.version + 1,
      };
      this.#store.channelBindingChallenges.set(id, cloneBindingChallenge(next));
      return cloneBindingChallenge(next);
    },

    complete: async (id, at) => {
      const current = this.#store.channelBindingChallenges.get(id);
      // The read and the write cannot interleave: JavaScript runs this
      // function to completion before another task observes the Map, which is
      // what the `completed_at is null` predicate buys in Postgres.
      if (!current || current.completedAt) return null;
      const next: ChannelBindingChallenge = {
        ...current,
        completedAt: at,
        version: current.version + 1,
      };
      this.#store.channelBindingChallenges.set(id, cloneBindingChallenge(next));
      return cloneBindingChallenge(next);
    },
  };

  readonly notificationPreferences: NotificationPreferenceRepository = {
    get: async (principalId) => {
      const row = this.#store.notificationPreferences.get(principalId);
      return row ? cloneNotificationPreferences(row) : null;
    },

    upsert: async (preferences, uow) => {
      const row = cloneNotificationPreferences(preferences);
      applyNowOrDefer(uow, () => {
        this.#store.notificationPreferences.set(
          row.principalId,
          cloneNotificationPreferences(row),
        );
      });
      return cloneNotificationPreferences(row);
    },
  };

  readonly notificationDeliveries: NotificationDeliveryRepository = {
    enqueue: async (delivery, uow) => {
      if (this.#store.notificationDeliveries.has(delivery.id)) {
        throw new ConflictError(
          `notification delivery already exists: ${delivery.id}`,
        );
      }
      const destinationId = deliveryDestinationId(delivery);
      for (const existing of this.#store.notificationDeliveries.values()) {
        if (
          existing.outboxEventId === delivery.outboxEventId &&
          existing.kind === delivery.kind &&
          deliveryDestinationId(existing) === destinationId
        ) {
          // The same unique index Postgres holds. The outbox is at-least-once,
          // so the router treats this as "already fanned out" rather than
          // ringing the same doorbell twice.
          throw new ConflictError(
            `notification delivery already fanned out: ${delivery.outboxEventId}/${delivery.kind}/${destinationId}`,
          );
        }
      }
      const row = cloneNotificationDelivery(delivery);
      applyNowOrDefer(uow, () => {
        this.#store.notificationDeliveries.set(
          row.id,
          cloneNotificationDelivery(row),
        );
      });
      return cloneNotificationDelivery(row);
    },

    claimDue: async (limit, now) => {
      const due = [...this.#store.notificationDeliveries.values()]
        .filter(
          (row) =>
            (row.state === "pending" || row.state === "failed") &&
            row.nextAttemptAt <= now,
        )
        .sort((a, b) => a.nextAttemptAt.getTime() - b.nextAttemptAt.getTime())
        .slice(0, limit);
      const claimed: NotificationDelivery[] = [];
      for (const row of due) {
        const next = cloneNotificationDelivery(row);
        next.attempts = row.attempts + 1;
        this.#store.notificationDeliveries.set(
          row.id,
          cloneNotificationDelivery(next),
        );
        claimed.push(next);
      }
      return claimed;
    },

    markDelivered: async (id, at, providerMessageRef) => {
      const row = this.#store.notificationDeliveries.get(id);
      // A missing row is a no-op in both implementations: the Postgres UPDATE
      // simply matches nothing, and a delivery ledger is not the place to
      // raise on a row a purge already took.
      if (!row) return;
      const next = cloneNotificationDelivery(row);
      next.state = "delivered";
      next.deliveredAt = at;
      if (providerMessageRef !== undefined) {
        next.providerMessageRef = providerMessageRef;
      }
      this.#store.notificationDeliveries.set(id, next);
    },

    recordFailure: async (id, error, nextAttemptAt, dead) => {
      const row = this.#store.notificationDeliveries.get(id);
      if (!row) return;
      const next = cloneNotificationDelivery(row);
      // A classified reason code, never a provider response body.
      next.lastError = error;
      next.nextAttemptAt = nextAttemptAt;
      next.state = dead ? "dead" : "failed";
      this.#store.notificationDeliveries.set(id, next);
    },

    existsForEvent: async (outboxEventId, kind, destinationId) => {
      for (const row of this.#store.notificationDeliveries.values()) {
        if (
          row.outboxEventId === outboxEventId &&
          row.kind === kind &&
          deliveryDestinationId(row) === destinationId
        ) {
          return true;
        }
      }
      return false;
    },

    listForRequest: async (authReqId) => {
      return [...this.#store.notificationDeliveries.values()]
        .filter((row) => row.authReqId === authReqId)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .map(cloneNotificationDelivery);
    },
  };

  readonly approvalActivations: ApprovalActivationRepository = {
    create: async (activation, uow) => {
      if (this.#store.approvalActivations.has(activation.id)) {
        throw new ConflictError(
          `approval activation already exists: ${activation.id}`,
        );
      }
      for (const existing of this.#store.approvalActivations.values()) {
        if (existing.challengeDigest === activation.challengeDigest) {
          throw new ConflictError(
            "approval activation challenge digest already issued",
          );
        }
      }
      const row = cloneActivation(activation);
      applyNowOrDefer(uow, () => {
        this.#store.approvalActivations.set(row.id, cloneActivation(row));
      });
      return cloneActivation(row);
    },

    getById: async (id) => {
      const row = this.#store.approvalActivations.get(id);
      return row ? cloneActivation(row) : null;
    },

    findByChallengeDigest: async (digest) => {
      for (const row of this.#store.approvalActivations.values()) {
        if (row.challengeDigest === digest) return cloneActivation(row);
      }
      return null;
    },

    updateWithVersion: async (id, expectedVersion, patch, uow) => {
      const current = this.#store.approvalActivations.get(id);
      if (!current) {
        throw new NotFoundError(`approval activation not found: ${id}`);
      }
      if (current.version !== expectedVersion) {
        throw new ConflictError(
          `approval activation version conflict: expected ${expectedVersion}, got ${current.version}`,
        );
      }
      const merged: ApprovalActivation = {
        ...current,
        ...patch,
        id: current.id,
        createdAt: current.createdAt,
        version: current.version + 1,
      };
      applyNowOrDefer(uow, () => {
        this.#store.approvalActivations.set(id, cloneActivation(merged));
      });
      return cloneActivation(merged);
    },

    consume: async (id, at) => {
      const current = this.#store.approvalActivations.get(id);
      // Compare-and-set, not read-then-write. The guard and the store happen
      // in one synchronous run, so of two settlements racing on the same
      // activation exactly one sees `activated` — the same property the
      // `state = 'activated'` predicate gives the Postgres UPDATE.
      if (!current || current.state !== "activated") return null;
      const next: ApprovalActivation = {
        ...current,
        state: "consumed",
        consumedAt: at,
        version: current.version + 1,
      };
      this.#store.approvalActivations.set(id, cloneActivation(next));
      return cloneActivation(next);
    },
  };

  readonly comparisonChallenges: ComparisonChallengeRepository = {
    create: async (challenge, uow) => {
      if (this.#store.comparisonChallenges.has(challenge.authReqId)) {
        // The unique index on `auth_req_id`, and the reason the attempt budget
        // means anything: re-issuing a code must collide rather than hand back
        // a fresh set of guesses against a six-digit value.
        throw new ConflictError(
          `comparison challenge already issued for request: ${challenge.authReqId}`,
        );
      }
      const row = cloneComparison(challenge);
      applyNowOrDefer(uow, () => {
        this.#store.comparisonChallenges.set(
          row.authReqId,
          cloneComparison(row),
        );
      });
      return cloneComparison(row);
    },

    getForRequest: async (authReqId) => {
      const row = this.#store.comparisonChallenges.get(authReqId);
      return row ? cloneComparison(row) : null;
    },

    consumeAttempt: async (authReqId, now) => {
      const current = this.#store.comparisonChallenges.get(authReqId);
      if (!current) return null;
      if (current.satisfiedAt) return null;
      if (current.expiresAt.getTime() <= now.getTime()) return null;
      // Budget checked and spent together. A budget a second caller can
      // observe mid-flight is not a budget.
      if (current.attempts >= current.maxAttempts) return null;
      const next: ComparisonChallenge = {
        ...current,
        attempts: current.attempts + 1,
        version: current.version + 1,
      };
      this.#store.comparisonChallenges.set(authReqId, cloneComparison(next));
      return cloneComparison(next);
    },

    markSatisfied: async (authReqId, at) => {
      const current = this.#store.comparisonChallenges.get(authReqId);
      if (!current || current.satisfiedAt) return null;
      const next: ComparisonChallenge = {
        ...current,
        satisfiedAt: at,
        version: current.version + 1,
      };
      this.#store.comparisonChallenges.set(authReqId, cloneComparison(next));
      return cloneComparison(next);
    },
  };

  readonly approvalReceipts: ApprovalReceiptRepository = {
    create: async (receipt, uow) => {
      if (this.#store.approvalReceipts.has(receipt.authReqId)) {
        throw new ConflictError(
          `approval receipt already recorded for request: ${receipt.authReqId}`,
        );
      }
      const row = cloneReceipt(receipt);
      applyNowOrDefer(uow, () => {
        this.#store.approvalReceipts.set(row.authReqId, cloneReceipt(row));
      });
      return cloneReceipt(row);
    },

    getForRequest: async (authReqId) => {
      const row = this.#store.approvalReceipts.get(authReqId);
      return row ? cloneReceipt(row) : null;
    },
  };

  readonly pushSubscriptions: PushSubscriptionRepository = {
    create: async (sub, uow) => {
      // The same endpoint is the same browser. Postgres holds
      // `endpoint_digest` unique and upserts onto it; here the existing row is
      // found and rewritten in place, keeping its id and `createdAt` and
      // reviving it if it had been disabled — a second row would push the same
      // person twice and leave the operator unable to say which is live.
      let existingId: string | undefined;
      let existingCreatedAt: Date | undefined;
      for (const row of this.#store.pushSubscriptions.values()) {
        if (row.endpointDigest === sub.endpointDigest) {
          existingId = row.id;
          existingCreatedAt = row.createdAt;
          break;
        }
      }
      const row: PushSubscription = {
        ...sub,
        ...(existingId ? { id: existingId } : undefined),
        ...(existingCreatedAt ? { createdAt: existingCreatedAt } : undefined),
      };
      if (!sub.disabledAt) Reflect.deleteProperty(row, "disabledAt");
      applyNowOrDefer(uow, () => {
        this.#store.pushSubscriptions.set(row.id, clonePushSubscription(row));
      });
      return clonePushSubscription(row);
    },

    listForPrincipal: async (principalId) => {
      return [...this.#store.pushSubscriptions.values()]
        .filter(
          (row) =>
            row.principalId === principalId && row.disabledAt === undefined,
        )
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .map(clonePushSubscription);
    },

    getById: async (id) => {
      const row = this.#store.pushSubscriptions.get(id);
      return row ? clonePushSubscription(row) : null;
    },

    findByEndpointDigest: async (digest) => {
      for (const row of this.#store.pushSubscriptions.values()) {
        if (row.endpointDigest === digest) return clonePushSubscription(row);
      }
      return null;
    },

    disable: async (id, at) => {
      const current = this.#store.pushSubscriptions.get(id);
      // Compare-and-set on "not already disabled", so only the caller that
      // actually retired the subscription is told it did.
      if (!current || current.disabledAt) return false;
      this.#store.pushSubscriptions.set(id, {
        ...current,
        disabledAt: at,
      });
      return true;
    },
  };

  readonly callbackReplays: CallbackReplayRepository = {
    claim: async (record) => {
      // The insert is the claim. `has` and `set` run in one synchronous turn —
      // JavaScript will not schedule another task between them — so this is
      // the same single round trip as the Postgres
      // `on conflict do nothing ... returning`. Checking first and writing
      // later is the race an attacker replaying a callback wins.
      if (this.#store.callbackReplays.has(record.id)) return false;
      this.#store.callbackReplays.set(record.id, cloneReplay(record));
      return true;
    },

    purgeExpired: async (now) => {
      let purged = 0;
      for (const [id, row] of this.#store.callbackReplays) {
        if (row.expiresAt.getTime() <= now.getTime()) {
          this.#store.callbackReplays.delete(id);
          purged += 1;
        }
      }
      return purged;
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

import { randomUUID } from "node:crypto";
import {
  type ApprovalActivation,
  type ApprovalReceipt,
  type AuditEvent,
  type AuthorizationRequest,
  type AuthorizationRequestStatus,
  type BetterAuthSubject,
  type ByoUpstream,
  type CallbackReplayRecord,
  type ClaimItem,
  type ClaimSession,
  type ComparisonChallenge,
  type ExternalChannelBinding,
  type ExternalIdentity,
  type Interaction,
  type InteractionKind,
  type InteractionStatus,
  type NotificationChannelKind,
  type NotificationDelivery,
  type NotificationPreferences,
  type Organization,
  type OrganizationMembership,
  type OutboxEvent,
  PERSONAL_PROJECT_SLUG,
  type Principal,
  type PrincipalId,
  type Project,
  type ProjectMembership,
  type WebhookDelivery,
  type WebhookEndpoint,
} from "@opensesame/os-domain";

export class ConflictError extends Error {
  override readonly name = "ConflictError";
  // biome-ignore lint/complexity/noUselessConstructor: Error needs the message passed to super.
  constructor(message: string) {
    super(message);
  }
}

export class NotFoundError extends Error {
  override readonly name = "NotFoundError";
  // biome-ignore lint/complexity/noUselessConstructor: Error needs the message passed to super.
  constructor(message: string) {
    super(message);
  }
}

export type NewOutboxEvent = Omit<
  OutboxEvent,
  "createdAt" | "availableAt" | "publishedAt" | "attempts" | "lastError"
> & {
  availableAt?: Date;
};

export interface UnitOfWork {
  appendOutbox(event: NewOutboxEvent): Promise<OutboxEvent>;
}

export type TransactionFn<T> = (uow: UnitOfWork) => Promise<T>;

/** Live drain claim encoded in `OutboxEvent.lastError`. */
export const OUTBOX_CLAIM_PREFIX = "claim:";
export const OUTBOX_CLAIM_HOLD_MS = 30_000;

export function outboxHoldActive(
  lastError: string | undefined,
  now: Date,
): boolean {
  if (!lastError?.startsWith(OUTBOX_CLAIM_PREFIX)) return false;
  const until = Number(lastError.slice(OUTBOX_CLAIM_PREFIX.length));
  return Number.isFinite(until) && until > now.getTime();
}

export function outboxClaimToken(
  now: Date,
  holdMs = OUTBOX_CLAIM_HOLD_MS,
): string {
  return `${OUTBOX_CLAIM_PREFIX}${now.getTime() + holdMs}`;
}

export interface PrincipalRepository {
  create(principal: Principal, uow?: UnitOfWork): Promise<Principal>;
  getById(id: string): Promise<Principal | null>;
  deleteUnlinkedProvisional(id: string, uow?: UnitOfWork): Promise<boolean>;
  update(
    id: string,
    patch: Partial<Omit<Principal, "id" | "createdAt">>,
    expectedVersion: number,
    uow?: UnitOfWork,
  ): Promise<Principal>;
}

export interface ExternalIdentityRepository {
  create(
    identity: ExternalIdentity,
    uow?: UnitOfWork,
  ): Promise<ExternalIdentity>;
  getById(id: string): Promise<ExternalIdentity | null>;
  findByTuple(input: {
    kind: string;
    issuer: string;
    tenant?: string;
    subject: string;
  }): Promise<ExternalIdentity | null>;
  listByPrincipal(principalId: string): Promise<ExternalIdentity[]>;
  listByEmailNormalized(email: string): Promise<ExternalIdentity[]>;
  /**
   * The verified identity whose owning principal is the oldest, for the
   * verified-email auto-link policy (ADR 0057).
   *
   * `email_normalized` is deliberately NOT unique — pre-existing rows may
   * already share an address — so the answer must be deterministic in code:
   * oldest owning principal wins, ties broken by principal id then identity
   * id. Rows carrying an explicitly unverified email are never candidates: an
   * upstream that lets a user type an arbitrary address must not become an
   * account-takeover path. `null` when nothing matches.
   */
  findVerifiedByEmail(
    emailNormalized: string,
  ): Promise<ExternalIdentity | null>;
  deleteById(id: string, uow?: UnitOfWork): Promise<boolean>;
}

/**
 * Trailing-slash-normalized issuer, the form every issuer comparison uses.
 * `https://idp.example/` and `https://idp.example` are the same issuer, and a
 * store that disagreed would mint a second upstream for the second spelling.
 */
export function normalizeIssuer(issuer: string): string {
  return issuer.trim().replace(/\/+$/, "");
}

/**
 * Bring-your-own upstreams (ADR 0055). Durable so a returning visitor who
 * re-enters their issuer resumes the same registration; `findByIssuer` is the
 * anti-enumeration read — callers never reveal whether a record pre-existed.
 */
export interface ByoUpstreamRepository {
  create(record: ByoUpstream): Promise<ByoUpstream>;
  getById(id: string): Promise<ByoUpstream | null>;
  /** Matches on the normalized issuer, whatever spelling the caller passes. */
  findByIssuer(issuer: string): Promise<ByoUpstream | null>;
  touchLastUsed(id: string, at: Date): Promise<void>;
  /** Operator surface: every record, newest registration first. */
  list(): Promise<ByoUpstream[]>;
  /** Operator surface: disable or re-enable one record. */
  setState(
    id: string,
    state: ByoUpstream["state"],
  ): Promise<ByoUpstream | null>;
}

export interface BetterAuthSubjectRepository {
  link(row: BetterAuthSubject, uow?: UnitOfWork): Promise<BetterAuthSubject>;
  getByBetterAuthUserId(userId: string): Promise<BetterAuthSubject | null>;
}

export interface ClaimSessionRepository {
  create(session: ClaimSession, uow?: UnitOfWork): Promise<ClaimSession>;
  getById(id: string): Promise<ClaimSession | null>;
  /**
   * Optimistic concurrency: update only when current version matches expectedVersion.
   * Increments version on success.
   */
  updateWithVersion(
    id: string,
    expectedVersion: number,
    patch: Partial<Omit<ClaimSession, "id" | "createdAt" | "version">>,
    uow?: UnitOfWork,
  ): Promise<ClaimSession>;
}

export interface ClaimItemRepository {
  create(item: ClaimItem, uow?: UnitOfWork): Promise<ClaimItem>;
  listByClaim(claimId: string): Promise<ClaimItem[]>;
}

export interface AuditEventRepository {
  append(event: AuditEvent, uow?: UnitOfWork): Promise<AuditEvent>;
  list(filter?: {
    principalId?: string;
    clientId?: string;
    organizationId?: string;
    limit?: number;
  }): Promise<AuditEvent[]>;
}

export interface OutboxRepository {
  append(event: NewOutboxEvent, uow?: UnitOfWork): Promise<OutboxEvent>;
  listUnpublished(limit?: number): Promise<OutboxEvent[]>;
  /**
   * Atomically claim unpublished rows for one drain pass. A live `claim:<deadlineMs>`
   * token in `lastError` hides the row from other workers until the hold expires.
   */
  claimUnpublished(
    limit?: number,
    now?: Date,
    holdMs?: number,
  ): Promise<OutboxEvent[]>;
  /** Drop a live claim so the next tick can retry immediately. */
  releaseClaim(id: string, error?: string): Promise<void>;
  markPublished(id: string, publishedAt?: Date): Promise<void>;
}

export interface AuthorizationRequestRepository {
  create(
    request: AuthorizationRequest,
    uow?: UnitOfWork,
  ): Promise<AuthorizationRequest>;
  getById(id: string): Promise<AuthorizationRequest | null>;
  /** The approver's inbox. Never lists another principal's requests. */
  listForPrincipal(
    principalId: string,
    filter?: { status?: AuthorizationRequestStatus; limit?: number },
  ): Promise<AuthorizationRequest[]>;
  /**
   * Optimistic concurrency, as for claims: two approvers racing must not both
   * believe they settled the request.
   *
   * The patch names exactly the fields a decision may move. It is deliberately
   * narrower than "any column": `requestDigest`, `authorizationDetails`, and
   * `bindingMessage` are what an approver consented to, and a repository that
   * accepted edits to them would let a settled request describe something
   * other than the thing that was approved. Narrowing here also keeps the
   * memory and Postgres implementations honest — a field one applies and the
   * other silently drops is a divergence tests would pass straight through.
   */
  updateWithVersion(
    id: string,
    expectedVersion: number,
    patch: Partial<
      Pick<
        AuthorizationRequest,
        | "status"
        | "expiresAt"
        | "decidedAt"
        | "decidedByPrincipalId"
        | "decidedByKind"
      >
    >,
    uow?: UnitOfWork,
  ): Promise<AuthorizationRequest>;
}

/**
 * The canonical cross-device interaction (ADR 0083).
 *
 * One store for every surface. A QR, a Google Wallet pass, a phone
 * notification and a CLI poll all address the same row, so there is exactly
 * one place where "which question is this, and is it still open?" is answered.
 *
 * The repository stores; it does not decide. Legality of a transition belongs
 * to `machines/interaction.ts` and is not restated here — a second copy of the
 * transition table is a second thing to get out of step with the first. What
 * storage owns is the part the machine cannot enforce from inside a single
 * process: that exactly one of two racing callers wins.
 */
export interface InteractionRepository {
  create(interaction: Interaction, uow?: UnitOfWork): Promise<Interaction>;
  getById(id: string): Promise<Interaction | null>;
  /**
   * The live interaction for a ceremony, if one exists.
   *
   * Live only, and that is the contract: once an interaction is terminal this
   * answers null, so a caller resuming a ceremony re-issues rather than
   * reviving a settled envelope. A photographed QR whose interaction was
   * consumed must never be findable again by the thing it fronted.
   */
  getBySubject(
    subjectKind: InteractionKind,
    subjectId: string,
  ): Promise<Interaction | null>;
  /** The approver's inbox. Never lists another principal's interactions. */
  listForApprover(
    principalId: string,
    filter?: { status?: InteractionStatus; limit?: number },
  ): Promise<Interaction[]>;
  /**
   * Optimistic concurrency, as for authorization requests: two executors
   * racing to spend one approval must not both believe they spent it. The
   * version check on the update — not the machine's `consume` — is what
   * actually serializes them, so this is the only place replay is stopped.
   *
   * The patch names exactly the fields a decision may move. It is deliberately
   * narrower than "any column": `kind`, `subject`, `expiresAt`,
   * `requestDigest`, `bindingMessage`, and `authorizationDetails` are what was
   * consented to, and a repository that accepted edits to them would let a
   * settled interaction describe something other than the thing that was
   * approved — the exact substitution the bound digest exists to refuse.
   * `expiresAt` is in that list for its own reason: a movable deadline is an
   * approval window that can be held open after the fact.
   */
  updateWithVersion(
    id: string,
    expectedVersion: number,
    patch: Partial<
      Pick<
        Interaction,
        | "status"
        | "approverPrincipalId"
        | "approvalProof"
        | "presentedAt"
        | "decidedAt"
        | "consumedAt"
        | "revokedAt"
      >
    >,
    uow?: UnitOfWork,
  ): Promise<Interaction>;
}

/**
 * Value or promise of one. Project stores are read on hot request paths where
 * the memory implementation answers synchronously (it is Map-backed) while the
 * Postgres implementation must await the database; callers always `await`.
 */
export type Awaitable<T> = T | Promise<T>;

/** Canonical sealed-store tomb name bound to every personal project. */
export const PERSONAL_PROJECT_TOMB_NAME = "personal";

/** Prefix of the auto-derived Pages vault folder id for a personal project. */
export const PERSONAL_VAULT_FOLDER_PREFIX = "vault_folder_";

/**
 * Build the one personal project a principal owns. Shared by both store
 * implementations so the row shape (slug, tomb binding, vault folder) cannot
 * drift between memory and Postgres.
 */
export function buildPersonalProject(
  principalId: string,
  now: Date,
  organizationId?: string,
): Project {
  const projectId = `prj_${randomUUID()}`;
  return {
    id: projectId,
    kind: "personal",
    slug: PERSONAL_PROJECT_SLUG,
    displayName: "Personal",
    state: "active",
    ownerPrincipalId: principalId,
    sealedStoreTombName: PERSONAL_PROJECT_TOMB_NAME,
    pagesVaultFolderId: `${PERSONAL_VAULT_FOLDER_PREFIX}${projectId.slice(4, 12)}`,
    createdAt: now,
    updatedAt: now,
    ...(organizationId !== undefined ? { organizationId } : undefined),
  };
}

export interface EnsurePersonalProjectResult {
  project: Project;
  created: boolean;
}

/**
 * Durable project rows (WP-8). `set` keeps the Map upsert semantics the
 * control-plane routes were written against: the caller owns the full row and
 * the store persists it verbatim.
 */
export interface ProjectStore {
  get(id: string): Awaitable<Project | undefined>;
  /** Full-row upsert (Map `set` semantics). */
  set(id: string, project: Project): Awaitable<void>;
  /** Every project owned by the principal, regardless of kind or state. */
  listByOwner(ownerPrincipalId: string): Awaitable<Project[]>;
  /** The principal's live personal project (not deleted / deleting). */
  findPersonalByOwner(ownerPrincipalId: string): Awaitable<Project | undefined>;
  /**
   * Ensure the principal's one personal project exists — a single upsert that
   * honors the `projects_personal_owner_uidx` partial unique index, so two
   * racing sessions converge on the same row. Also mints the owner membership
   * when the project is created.
   */
  ensurePersonal(
    principalId: string,
    organizationId?: string,
    now?: Date,
  ): Awaitable<EnsurePersonalProjectResult>;
}

/** Durable project membership rows keyed by (projectId, principalId). */
export interface ProjectMembershipStore {
  find(
    projectId: string,
    principalId: string,
  ): Awaitable<ProjectMembership | undefined>;
  upsert(membership: ProjectMembership): Awaitable<ProjectMembership>;
  remove(projectId: string, principalId: string): Awaitable<boolean>;
  /** Drop every membership of a project (project deletion). */
  removeByProject(projectId: string): Awaitable<number>;
  listByProject(projectId: string): Awaitable<ProjectMembership[]>;
  listByPrincipal(principalId: string): Awaitable<ProjectMembership[]>;
  countOwners(projectId: string): Awaitable<number>;
}

/** The pair travels together: `ensurePersonal` writes both tables. */
export interface ProjectStores {
  projects: ProjectStore;
  projectMemberships: ProjectMembershipStore;
}

/**
 * Durable organization rows. Tenant SSO/SAML config lives on this row and is
 * read on the login path, so it cannot stay in process memory: a restart that
 * forgets an org's issuer silently turns enterprise sign-in off.
 *
 * `set` keeps the Map upsert semantics the control-plane routes were written
 * against — the caller owns the full row and the store persists it verbatim.
 */
export interface OrganizationStore {
  get(id: string): Awaitable<Organization | undefined>;
  /** Full-row upsert (Map `set` semantics). */
  set(id: string, organization: Organization): Awaitable<void>;
  getBySlug(slug: string): Awaitable<Organization | undefined>;
  /**
   * The org whose `ssoIssuer` OR `samlIssuer` is this issuer, compared
   * trailing-slash-normalized (the stored spelling is left as the operator
   * typed it). Undefined when no org claims it.
   */
  findByIssuer(issuer: string): Awaitable<Organization | undefined>;
  listByCreator(principalId: string): Awaitable<Organization[]>;
}

/** Durable organization membership rows keyed by (organizationId, principalId). */
export interface OrganizationMembershipStore {
  find(
    organizationId: string,
    principalId: string,
  ): Awaitable<OrganizationMembership | undefined>;
  upsert(membership: OrganizationMembership): Awaitable<OrganizationMembership>;
  remove(organizationId: string, principalId: string): Awaitable<boolean>;
  listByOrganization(
    organizationId: string,
  ): Awaitable<OrganizationMembership[]>;
  listByPrincipal(principalId: string): Awaitable<OrganizationMembership[]>;
  /** Owner count — the fence against demoting or removing the last owner. */
  countOwners(organizationId: string): Awaitable<number>;
}

/** The pair travels together, as projects do. */
export interface OrganizationStores {
  organizations: OrganizationStore;
  organizationMemberships: OrganizationMembershipStore;
}

/**
 * Row shape both organization stores agree on.
 *
 * Optional fields are present only when set — a Postgres NULL reads back as an
 * absent key, so the memory store must drop empty values too or a round-trip
 * that passes in memory fails against the database (and vice versa).
 */
export function normalizeOrganizationRow(
  organization: Organization,
): Organization {
  const row: Organization = {
    id: organization.id,
    slug: organization.slug,
    displayName: organization.displayName,
    state: organization.state,
    createdBy: organization.createdBy,
    createdAt: organization.createdAt,
    updatedAt: organization.updatedAt,
  };
  if (organization.ssoIssuer) row.ssoIssuer = organization.ssoIssuer;
  if (organization.ssoClientId) row.ssoClientId = organization.ssoClientId;
  if (organization.ssoClientSecret) {
    row.ssoClientSecret = organization.ssoClientSecret;
  }
  if (organization.samlIssuer) row.samlIssuer = organization.samlIssuer;
  if (organization.samlMetadataUrl) {
    row.samlMetadataUrl = organization.samlMetadataUrl;
  }
  if (organization.samlMetadataXml) {
    row.samlMetadataXml = organization.samlMetadataXml;
  }
  if (organization.provisioningEnabled) row.provisioningEnabled = true;
  return row;
}

/** True when either issuer column of `organization` names `issuer`. */
export function organizationClaimsIssuer(
  organization: Organization,
  issuer: string,
): boolean {
  const target = normalizeIssuer(issuer);
  if (!target) return false;
  return (
    (organization.ssoIssuer !== undefined &&
      normalizeIssuer(organization.ssoIssuer) === target) ||
    (organization.samlIssuer !== undefined &&
      normalizeIssuer(organization.samlIssuer) === target)
  );
}

export interface WebhookEndpointRepository {
  create(endpoint: WebhookEndpoint, uow?: UnitOfWork): Promise<WebhookEndpoint>;
  getById(id: string): Promise<WebhookEndpoint | null>;
  /** Live endpoints only: a disabled receiver gets nothing. */
  listForPrincipal(principalId: string): Promise<WebhookEndpoint[]>;
  deleteById(id: string, uow?: UnitOfWork): Promise<boolean>;
}

export interface WebhookDeliveryRepository {
  enqueue(
    delivery: WebhookDelivery,
    uow?: UnitOfWork,
  ): Promise<WebhookDelivery>;
  /**
   * Due, undelivered, un-dead deliveries — attempts bumped on claim so two
   * dispatchers racing cannot both count the same try as the first.
   */
  claimDue(limit: number, now: Date): Promise<WebhookDelivery[]>;
  markDelivered(id: string, at: Date): Promise<void>;
  /** Failure with the next attempt already scheduled; `dead` ends retrying. */
  recordFailure(
    id: string,
    error: string,
    nextAttemptAt: Date,
    dead: boolean,
  ): Promise<void>;
}

/* ------------------------------------------------------------------ *
 * External notification channels and approval ceremonies (ADR 0084)
 * ------------------------------------------------------------------ */

/**
 * A short-lived challenge for the ceremony that adds a notification
 * destination.
 *
 * Adding a destination changes where authorization prompts can appear, so it
 * is itself a security-sensitive operation: a challenge is bound to the
 * principal, the channel and the proposed provider identity, expires, and
 * succeeds exactly once. Only the digest of the nonce is stored — the nonce
 * itself lives in one response body and in the provider round-trip, never at
 * rest.
 */
export interface ChannelBindingChallenge {
  id: string;
  principalId: string;
  kind: NotificationChannelKind;
  providerId: string;
  /** Digest of the one-time nonce. Never the nonce. */
  nonceDigest: string;
  /** The provider identity this challenge may complete against, if pinned. */
  expectedTenantId?: string;
  expectedSubjectId?: string;
  attempts: number;
  maxAttempts: number;
  createdAt: Date;
  expiresAt: Date;
  completedAt?: Date;
  version: number;
}

export interface ChannelBindingRepository {
  create(
    binding: ExternalChannelBinding,
    uow?: UnitOfWork,
  ): Promise<ExternalChannelBinding>;
  getById(id: string): Promise<ExternalChannelBinding | null>;
  listForPrincipal(principalId: string): Promise<ExternalChannelBinding[]>;
  /**
   * Resolve a callback's claimed provider identity to a binding.
   *
   * All three components are part of the key. Subject ids are unique within a
   * provider tenant and not across them, so a lookup by subject alone lets a
   * caller who controls their own workspace mint an identity that collides
   * with somebody else's binding.
   */
  findByProviderIdentity(
    kind: NotificationChannelKind,
    providerId: string,
    providerTenantId: string,
    providerSubjectId: string,
  ): Promise<ExternalChannelBinding | null>;
  updateWithVersion(
    id: string,
    expectedVersion: number,
    patch: Partial<
      Pick<
        ExternalChannelBinding,
        "state" | "verifiedAt" | "revokedAt" | "expiresAt" | "displayLabel"
      >
    >,
    uow?: UnitOfWork,
  ): Promise<ExternalChannelBinding>;
}

export interface ChannelBindingChallengeRepository {
  create(
    challenge: ChannelBindingChallenge,
    uow?: UnitOfWork,
  ): Promise<ChannelBindingChallenge>;
  getById(id: string): Promise<ChannelBindingChallenge | null>;
  /**
   * Spend one attempt against the stored budget, atomically.
   *
   * Durable rather than counted in memory: an attempt budget a second replica
   * cannot see is not a budget, and the value being guessed is short.
   */
  consumeAttempt(
    id: string,
    now: Date,
  ): Promise<ChannelBindingChallenge | null>;
  /** Exactly one caller may complete a challenge. Losers get null. */
  complete(id: string, at: Date): Promise<ChannelBindingChallenge | null>;
}

export interface NotificationPreferenceRepository {
  get(principalId: string): Promise<NotificationPreferences | null>;
  upsert(
    preferences: NotificationPreferences,
    uow?: UnitOfWork,
  ): Promise<NotificationPreferences>;
}

export interface NotificationDeliveryRepository {
  enqueue(
    delivery: NotificationDelivery,
    uow?: UnitOfWork,
  ): Promise<NotificationDelivery>;
  /** Attempts counted on claim, so a crash mid-send still burned a try. */
  claimDue(limit: number, now: Date): Promise<NotificationDelivery[]>;
  markDelivered(
    id: string,
    at: Date,
    providerMessageRef?: string,
  ): Promise<void>;
  recordFailure(
    id: string,
    error: string,
    nextAttemptAt: Date,
    dead: boolean,
  ): Promise<void>;
  /**
   * Has this outbox event already fanned out to this destination?
   *
   * The outbox is at-least-once, so the fan-out must be idempotent or a
   * retried drain rings the same doorbell twice.
   */
  existsForEvent(
    outboxEventId: string,
    kind: NotificationChannelKind,
    destinationId: string,
  ): Promise<boolean>;
  listForRequest(authReqId: string): Promise<NotificationDelivery[]>;
}

export interface ApprovalActivationRepository {
  create(
    activation: ApprovalActivation,
    uow?: UnitOfWork,
  ): Promise<ApprovalActivation>;
  getById(id: string): Promise<ApprovalActivation | null>;
  findByChallengeDigest(digest: string): Promise<ApprovalActivation | null>;
  updateWithVersion(
    id: string,
    expectedVersion: number,
    patch: Partial<
      Pick<
        ApprovalActivation,
        "state" | "activatedAt" | "consumedAt" | "trustSessionId" | "method"
      >
    >,
    uow?: UnitOfWork,
  ): Promise<ApprovalActivation>;
  /**
   * Spend an activation, exactly once, atomically.
   *
   * A compare-and-set rather than a read-then-write: two settlements racing
   * on the same activation must not both succeed, and the loser must be told
   * rather than silently applied.
   */
  consume(id: string, at: Date): Promise<ApprovalActivation | null>;
}

export interface ComparisonChallengeRepository {
  create(
    challenge: ComparisonChallenge,
    uow?: UnitOfWork,
  ): Promise<ComparisonChallenge>;
  getForRequest(authReqId: string): Promise<ComparisonChallenge | null>;
  /**
   * Spend one guess. Durable, and deliberately not reset by re-issuing a
   * code: a budget that a second `POST` refills is not a budget.
   */
  consumeAttempt(
    authReqId: string,
    now: Date,
  ): Promise<ComparisonChallenge | null>;
  markSatisfied(
    authReqId: string,
    at: Date,
  ): Promise<ComparisonChallenge | null>;
}

export interface ApprovalReceiptRepository {
  create(receipt: ApprovalReceipt, uow?: UnitOfWork): Promise<ApprovalReceipt>;
  getForRequest(authReqId: string): Promise<ApprovalReceipt | null>;
}

/**
 * A W3C Push subscription.
 *
 * Deliberately not an `ExternalChannelBinding`. A binding's `metadata` is
 * documented as digest-shaped and never secret, and a push subscription
 * carries two things that are neither: `endpoint` is a capability URL — a
 * bearer credential for pushing to that browser, which anyone holding it can
 * use — and `authSecret` is the RFC 8291 shared secret that the content
 * encryption is keyed from. Both must be stored whole, because signing and
 * encrypting need the raw bytes (the same reason `webhook_endpoints.secret`
 * cannot be a hash), and neither may ever reach an API response, a log line,
 * or a notification body. `endpointDigest` exists so a subscription can be
 * deduplicated and named without either.
 *
 * NOTE FOR THE COORDINATOR: this type lives here rather than in
 * `packages/os-domain/src/approval-ceremony.ts` only because this agent's
 * scope is `packages/database`. It is a pure domain shape and belongs beside
 * the other ADR 0084 types; move it when convenient — the only import to
 * repoint is `ChannelBindingChallenge`-style, i.e. this file's own re-export.
 */
export interface PushSubscription {
  id: string;
  principalId: PrincipalId;
  /** Capability URL: anyone holding it can push to that browser. Never returned by any API. */
  endpoint: string;
  /** Subscriber public key (P-256, base64url). Not secret, but not useful alone. */
  p256dhKey: string;
  /** RFC 8291 auth secret. Secret — write-only, never returned, never logged. */
  authSecret: string;
  /** Digest of the endpoint, for dedupe and for naming a subscription in a log. */
  endpointDigest: string;
  deviceLabel?: string;
  createdAt: Date;
  lastUsedAt?: Date;
  disabledAt?: Date;
}

export interface PushSubscriptionRepository {
  /**
   * Register a subscription. A browser that re-subscribes presents the same
   * endpoint, and the same endpoint is the same destination: the store
   * replaces the stored keys in place (keeping the existing row's id and
   * `createdAt`, and reviving a disabled row) rather than accumulating a
   * second row that pushes to the same browser.
   */
  create(sub: PushSubscription, uow?: UnitOfWork): Promise<PushSubscription>;
  /** Live subscriptions only — a disabled one is not a destination. */
  listForPrincipal(principalId: string): Promise<PushSubscription[]>;
  getById(id: string): Promise<PushSubscription | null>;
  /** A browser re-subscribing with the same endpoint must replace, not duplicate. */
  findByEndpointDigest(digest: string): Promise<PushSubscription | null>;
  /** Compare-and-set: true only for the caller that actually disabled it. */
  disable(id: string, at: Date): Promise<boolean>;
}

export interface CallbackReplayRepository {
  /**
   * Record a callback as seen, and say whether it already was.
   *
   * `true` means this caller is the first to claim it. The insert is the
   * claim — checking then inserting is a race an attacker replaying a
   * callback into two replicas wins.
   */
  claim(record: CallbackReplayRecord): Promise<boolean>;
  purgeExpired(now: Date): Promise<number>;
}

export interface Repositories {
  principals: PrincipalRepository;
  authorizationRequests: AuthorizationRequestRepository;
  interactions: InteractionRepository;
  externalIdentities: ExternalIdentityRepository;
  byoUpstreams: ByoUpstreamRepository;
  betterAuthSubjects: BetterAuthSubjectRepository;
  claimSessions: ClaimSessionRepository;
  claimItems: ClaimItemRepository;
  auditEvents: AuditEventRepository;
  outbox: OutboxRepository;
  webhookEndpoints: WebhookEndpointRepository;
  webhookDeliveries: WebhookDeliveryRepository;
  channelBindings: ChannelBindingRepository;
  channelBindingChallenges: ChannelBindingChallengeRepository;
  notificationPreferences: NotificationPreferenceRepository;
  notificationDeliveries: NotificationDeliveryRepository;
  approvalActivations: ApprovalActivationRepository;
  comparisonChallenges: ComparisonChallengeRepository;
  approvalReceipts: ApprovalReceiptRepository;
  pushSubscriptions: PushSubscriptionRepository;
  callbackReplays: CallbackReplayRepository;
  /**
   * Run work in a single transaction. Domain writes + outbox append must share this boundary.
   */
  transaction<T>(fn: TransactionFn<T>): Promise<T>;
}

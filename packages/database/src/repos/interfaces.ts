import { randomUUID } from "node:crypto";
import {
  type AuditEvent,
  type AuthorizationRequest,
  type AuthorizationRequestStatus,
  type BetterAuthSubject,
  type ClaimItem,
  type ClaimSession,
  type ExternalIdentity,
  type OutboxEvent,
  PERSONAL_PROJECT_SLUG,
  type Principal,
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
  deleteById(id: string, uow?: UnitOfWork): Promise<boolean>;
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

export interface Repositories {
  principals: PrincipalRepository;
  authorizationRequests: AuthorizationRequestRepository;
  externalIdentities: ExternalIdentityRepository;
  betterAuthSubjects: BetterAuthSubjectRepository;
  claimSessions: ClaimSessionRepository;
  claimItems: ClaimItemRepository;
  auditEvents: AuditEventRepository;
  outbox: OutboxRepository;
  webhookEndpoints: WebhookEndpointRepository;
  webhookDeliveries: WebhookDeliveryRepository;
  /**
   * Run work in a single transaction. Domain writes + outbox append must share this boundary.
   */
  transaction<T>(fn: TransactionFn<T>): Promise<T>;
}

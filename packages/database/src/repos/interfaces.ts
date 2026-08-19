import type {
  AuditEvent,
  AuthorizationRequest,
  AuthorizationRequestStatus,
  BetterAuthSubject,
  ClaimItem,
  ClaimSession,
  ExternalIdentity,
  OutboxEvent,
  Principal,
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

export interface Repositories {
  principals: PrincipalRepository;
  authorizationRequests: AuthorizationRequestRepository;
  externalIdentities: ExternalIdentityRepository;
  betterAuthSubjects: BetterAuthSubjectRepository;
  claimSessions: ClaimSessionRepository;
  claimItems: ClaimItemRepository;
  auditEvents: AuditEventRepository;
  outbox: OutboxRepository;
  /**
   * Run work in a single transaction. Domain writes + outbox append must share this boundary.
   */
  transaction<T>(fn: TransactionFn<T>): Promise<T>;
}

import type {
  AuditEvent,
  BetterAuthSubject,
  ClaimItem,
  ClaimSession,
  ExternalIdentity,
  OutboxEvent,
  Principal,
} from "@opensesame/os-domain";

export class ConflictError extends Error {
  override readonly name = "ConflictError";
  constructor(message: string) {
    super(message);
  }
}

export class NotFoundError extends Error {
  override readonly name = "NotFoundError";
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

export interface PrincipalRepository {
  create(principal: Principal, uow?: UnitOfWork): Promise<Principal>;
  getById(id: string): Promise<Principal | null>;
  update(
    id: string,
    patch: Partial<Omit<Principal, "id" | "createdAt">>,
    expectedVersion: number,
    uow?: UnitOfWork,
  ): Promise<Principal>;
}

export interface ExternalIdentityRepository {
  create(identity: ExternalIdentity, uow?: UnitOfWork): Promise<ExternalIdentity>;
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
  markPublished(id: string, publishedAt?: Date): Promise<void>;
}

export interface Repositories {
  principals: PrincipalRepository;
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

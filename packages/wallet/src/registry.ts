/**
 * The local record of which launcher passes exist, and which are turned off.
 *
 * A launcher's authority to open OpenSesame is a fact this deployment owns, not
 * a fact Google owns. That distinction is the whole point of this module:
 * turning a launcher off must succeed on this device the instant it is asked,
 * whether or not `walletobjects.googleapis.com` is reachable, whether or not
 * the object was ever provisioned there, and whether or not Google later agrees
 * to expire it. If disablement depended on Google, a Google outage would be a
 * period during which a lost phone's launcher could not be revoked — exactly
 * when revoking it matters most.
 *
 * So the model is: the store is the source of truth for `active` vs
 * `disabled`. `disable` flips the local record and returns; expiring the Google
 * object is a separate, best-effort call the caller makes afterward (see
 * `launcher.ts` `disableLauncher`), and its failure never resurrects a local
 * disablement.
 *
 * The interface lives in this package so the rule is testable here in
 * isolation; a deployment wires a durable implementation behind it. The
 * in-memory store is the reference implementation and the one tests use.
 */

export type WalletRegistrationState = "active" | "disabled";

/**
 * One launcher registration, as this deployment records it.
 *
 * Deliberately holds no seed and no Google object body — those live at Google.
 * `passId` is the derived Google object id, kept so a disablement can address
 * the object without re-deriving it, and it is not a secret.
 */
export interface WalletRegistration {
  registrationId: string;
  state: WalletRegistrationState;
  /** The principal this launcher belongs to, so a list can be scoped. */
  ownerPrincipalId: string;
  /** Google object id, for the best-effort expiry call. */
  passId: string;
  createdAt: Date;
  disabledAt?: Date;
}

/** What a caller supplies to record a new registration. */
export interface WalletRegistrationInput {
  registrationId: string;
  ownerPrincipalId: string;
  passId: string;
}

/**
 * The local registration store.
 *
 * `disable` is the load-bearing verb: it must be a local write that does not
 * consult Google. `get`/`list` are scoped reads. `create` records a new one.
 */
export interface WalletRegistrationStore {
  create(input: WalletRegistrationInput): Promise<WalletRegistration>;
  get(registrationId: string): Promise<WalletRegistration | null>;
  list(ownerPrincipalId: string): Promise<readonly WalletRegistration[]>;
  /**
   * Turn a registration off locally.
   *
   * Idempotent: disabling an already-disabled registration is success. Returns
   * the disabled record, or null if there was no such registration — a caller
   * cannot be told a launcher it never owned was turned off.
   */
  disable(registrationId: string): Promise<WalletRegistration | null>;
}

/** A registration id already recorded. */
export class WalletRegistrationConflictError extends Error {
  readonly registrationId: string;
  constructor(registrationId: string) {
    super(`a wallet registration "${registrationId}" already exists`);
    this.name = "WalletRegistrationConflictError";
    this.registrationId = registrationId;
  }
}

/**
 * The reference in-memory store.
 *
 * Correct for a single-process deployment and for tests; a multi-replica
 * deployment supplies a durable implementation of the same interface. The
 * clock is injected so `disabledAt` is assertable.
 */
export class InMemoryWalletRegistrationStore
  implements WalletRegistrationStore
{
  private readonly rows = new Map<string, WalletRegistration>();
  private readonly clock: () => Date;

  constructor(clock: () => Date = () => new Date()) {
    this.clock = clock;
  }

  create(input: WalletRegistrationInput): Promise<WalletRegistration> {
    if (this.rows.has(input.registrationId)) {
      return Promise.reject(
        new WalletRegistrationConflictError(input.registrationId),
      );
    }
    const row: WalletRegistration = {
      registrationId: input.registrationId,
      state: "active",
      ownerPrincipalId: input.ownerPrincipalId,
      passId: input.passId,
      createdAt: this.clock(),
    };
    this.rows.set(row.registrationId, row);
    return Promise.resolve({ ...row });
  }

  get(registrationId: string): Promise<WalletRegistration | null> {
    const row = this.rows.get(registrationId);
    return Promise.resolve(row ? { ...row } : null);
  }

  list(ownerPrincipalId: string): Promise<readonly WalletRegistration[]> {
    const rows = [...this.rows.values()]
      .filter((row) => row.ownerPrincipalId === ownerPrincipalId)
      .map((row) => ({ ...row }));
    return Promise.resolve(rows);
  }

  disable(registrationId: string): Promise<WalletRegistration | null> {
    const row = this.rows.get(registrationId);
    if (!row) return Promise.resolve(null);
    if (row.state === "disabled") return Promise.resolve({ ...row });
    const disabled: WalletRegistration = {
      ...row,
      state: "disabled",
      disabledAt: this.clock(),
    };
    this.rows.set(registrationId, disabled);
    return Promise.resolve({ ...disabled });
  }
}

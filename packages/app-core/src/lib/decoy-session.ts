import {
  persistPendingOwnerContext,
  removePendingOwnerContext,
  restorePendingOwnerContext,
} from "./decoy-auth-context.js";
/** Tab-local synthetic realm boundary; never a device-wide incident fence. */
let active = false;
let realmGeneration = 0;
let syntheticTransition = 0;
const syntheticListeners = new Set<() => void>();

/** Retire independently owned transports when a synthetic realm begins. */
export function onSyntheticTransition(listener: () => void): () => void {
  syntheticListeners.add(listener);
  return () => syntheticListeners.delete(listener);
}
let freshOwnerAuthentication = false;
let originatingTomb: string | null = null;
let originatingVault: string | null = null;
export type DecoyInteraction = "vault_write" | "authority_denied";
let observer: ((action: DecoyInteraction) => void) | null = null;
function restoreOwnerContext(): void {
  const pending = restorePendingOwnerContext();
  if (pending) {
    freshOwnerAuthentication = true;
    originatingTomb = pending.tomb;
    originatingVault = pending.vaultIdentity;
  }
}

/** Bound to a retired trap when its synthetic session is constructed. */
export function setDecoyInteractionObserver(
  next: (action: DecoyInteraction) => void,
): void {
  observer = next;
}

export function observeDecoyInteraction(action: DecoyInteraction): void {
  if (!active) return;
  try {
    observer?.(action);
  } catch {
    /* Local telemetry never changes authorization. */
  }
}

export function isDecoySession(): boolean {
  return active;
}

/** Presentation can be locked while protected real authority still needs proof. */
export function isRealAuthorityBlocked(): boolean {
  restoreOwnerContext();
  return active || freshOwnerAuthentication;
}

/** Snapshot a deliberate transition before awaiting its eventual completion. */
/** Entering a synthetic realm permanently retires prior tab-local key admissions. */
export function currentSyntheticTransition(): number {
  return syntheticTransition;
}

export function currentRealmGeneration(): number {
  return realmGeneration;
}

export function assertDecoySession(expectedGeneration: number): void {
  if (!active || expectedGeneration !== realmGeneration)
    throw new Error(
      "Synthetic session changed. Lock it and authenticate again.",
    );
}

export function markDecoySession(
  on: boolean,
  ownerTomb?: string,
  ownerVaultIdentity?: string,
): boolean {
  restoreOwnerContext();
  const previous = active;
  active = on;
  if (on) {
    syntheticTransition += 1;
    if (!freshOwnerAuthentication) {
      originatingTomb = ownerTomb ?? null;
      originatingVault = ownerVaultIdentity ?? null;
    }
    freshOwnerAuthentication = true;
  }
  try {
    if (on) persistPendingOwnerContext(originatingTomb, originatingVault);
  } finally {
    realmGeneration += 1;
    observer = null;
    if (on) {
      for (const listener of [...syntheticListeners]) {
        try {
          listener();
        } catch {
          // One transport cannot prevent other original sessions from retiring.
        }
      }
    }
  }
  return previous;
}

/** Lock removes presentation, never the need to prove the original owner again. */
export function requiresFreshOwnerAuthentication(): boolean {
  restoreOwnerContext();
  return freshOwnerAuthentication;
}

/** Internal admission context; it carries no secret or authentication proof. */
export function freshOwnerAuthenticationTomb(): string | null {
  restoreOwnerContext();
  return originatingTomb;
}

export function freshOwnerAuthenticationVault(): string | null {
  restoreOwnerContext();
  return originatingVault;
}

/** Local authentication may derive a new real key while external authority stays sealed. */
export function assertAuthenticationSession(
  expectedGeneration?: number,
): number {
  if (
    active ||
    (expectedGeneration !== undefined && expectedGeneration !== realmGeneration)
  ) {
    observeDecoyInteraction("authority_denied");
    throw new Error(
      "This session cannot use external or member capabilities. Lock it and authenticate again.",
    );
  }
  return realmGeneration;
}

/** Called only by fresh real authentication after all configured factors succeed. */
export function admitFreshOwnerAuthentication(
  tomb: string | null,
  expectedRealm: number,
  ownerVaultIdentity: string | null = null,
): void {
  assertAuthenticationSession(expectedRealm);
  restoreOwnerContext();
  if (!freshOwnerAuthentication) return;
  if (originatingTomb !== tomb || originatingVault !== ownerVaultIdentity)
    throw new Error(
      "Authenticate the original vault before using member capabilities.",
    );
  removePendingOwnerContext();
  freshOwnerAuthentication = false;
  originatingTomb = null;
  originatingVault = null;
}

/** Enforce isolation before reaching ambient credentials or external capabilities. */
export function assertNotDecoySession(expectedGeneration?: number): number {
  restoreOwnerContext();
  const generation = assertAuthenticationSession(expectedGeneration);
  if (freshOwnerAuthentication)
    throw new Error(
      "This session cannot use external or member capabilities. Lock it and authenticate again.",
    );
  return generation;
}

/** Pin descendants to their starting real realm, including rejected operations. */
export async function withRealAuthority<T>(work: () => Promise<T>): Promise<T> {
  const authorityGeneration = assertNotDecoySession();
  try {
    return await work();
  } finally {
    assertNotDecoySession(authorityGeneration);
  }
}

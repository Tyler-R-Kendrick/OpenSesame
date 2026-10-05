/**
 * Open a sealed JSON value that should be bound to its path, accepting a
 * legacy unbound seal once so the caller can rewrite it bound
 * (`seal-rebind.ts`). Pure: the key and the blob are all it needs.
 *
 * Also home to `normalizeVaultBody`, the one place an opened body is brought
 * up to the current item model (ADR 0166 §1): every reader of a body — the
 * store, a sync snapshot, a backup, an export — passes what it opened through
 * it, so no `login` item outlives the read.
 */
import { isLegacyLogin, migrateLegacyLogin } from "./account.js";
import type { LegacyLoginItem } from "./account.js";
import { type SealedBlob, VaultCorruptError, openJson } from "./crypto.js";
import type { VaultBody, VaultItem } from "./model.js";

export type ReboundSeal<T> = {
  readonly value: T;
  readonly rebound: boolean;
};

/** Open unbound once so unlock can rewrite the seal with a path binding. */
export async function openJsonForRebind<T>(
  vaultKey: CryptoKey,
  blob: SealedBlob,
  binding: string,
): Promise<ReboundSeal<T>> {
  try {
    const bound = {
      value: await openJson(vaultKey, blob, binding),
      rebound: false as const,
    } satisfies ReboundSeal<T>;
    return bound;
  } catch (error) {
    if (!(error instanceof VaultCorruptError)) throw error;
    const unbound = {
      value: await openJson(vaultKey, blob),
      rebound: true as const,
    } satisfies ReboundSeal<T>;
    return unbound;
  }
}

/** A legacy login read from JSON may lack a field an old writer never set. */
function wholeLegacyLogin(legacy: LegacyLoginItem): LegacyLoginItem {
  const text = (value: unknown, fallback = ""): string =>
    typeof value === "string" ? value : fallback;
  return {
    ...legacy,
    username: text(legacy.username),
    password: text(legacy.password),
    totp: text(legacy.totp),
    uris: Array.isArray(legacy.uris) ? legacy.uris : [],
    passwordChangedAt: text(legacy.passwordChangedAt, text(legacy.createdAt)),
  };
}

/**
 * Every legacy login in `items` becomes an account (ADR 0166 §1). Idempotent,
 * and the method ids derive from the item id, so two devices that normalize
 * the same login produce the same account.
 */
export function normalizeItems(
  items: readonly (VaultItem | LegacyLoginItem)[],
): VaultItem[] {
  return items.map((item) =>
    isLegacyLogin(item) ? migrateLegacyLogin(wholeLegacyLogin(item)) : item,
  );
}

/** True when `body` still holds an item from before ADR 0166. */
export function hasLegacyItems(body: Pick<VaultBody, "items">): boolean {
  // An export is whatever its author wrote: a body with no list has none.
  return Array.isArray(body.items) && body.items.some(isLegacyLogin);
}

/** `body` with no legacy item left in it; `body` itself when it had none. */
export function normalizeVaultBody(body: VaultBody): VaultBody {
  return hasLegacyItems(body)
    ? { ...body, items: normalizeItems(body.items) }
    : body;
}

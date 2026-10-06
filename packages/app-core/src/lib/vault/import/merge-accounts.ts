/**
 * Folding one account's login methods into another's (ADR 0172).
 *
 * `planMerge` still skips an incoming item the vault already holds. This is the
 * primitive for a caller that would rather keep what the second copy knows: it
 * adds the methods the first lacks and reports the ones it will not take.
 *
 * - The same method (same id, or the same type holding the same secret) is a
 *   duplicate and is left out.
 * - A different password is a **conflict**: the existing one wins and the
 *   incoming one is reported, as a duplicate import has always left the vault's
 *   copy standing. A password is the one method an account has a single answer
 *   for.
 * - Anything else (an API key, a token, a client, a second authenticator)
 *   is additive: an account may hold several, so it is added.
 *
 * Pure: nothing here reads a pepper, a sealed envelope or an OPRF key. A method
 * one cannot produce (an older version's) is compared by id only.
 */

import {
  type AccountItem,
  type LoginMethod,
  type PasswordMethod,
  newMethodId,
  producePassword,
} from "@opensesame/vault-core";

export type AccountMerge = {
  account: AccountItem;
  /** Methods taken from the incoming account. */
  added: LoginMethod[];
  /** Incoming methods the existing account already holds. */
  duplicates: LoginMethod[];
  /** Incoming passwords that differ from the one the account keeps. */
  conflicts: PasswordMethod[];
};

function secretOf(method: LoginMethod): string | null {
  switch (method.type) {
    case "password": {
      const produced = producePassword(method);
      if (produced.status === "ok") return produced.password;
      return produced.status === "slotted"
        ? `${produced.head}\u0000${produced.tail}`
        : null;
    }
    case "authenticator":
      return method.secret;
    case "api-key":
      return method.key;
    case "token":
      return method.token;
    case "oauth":
      return `${method.clientId}\n${method.clientSecret}\n${method.refreshToken}`;
  }
}

function sameMethod(a: LoginMethod, b: LoginMethod): boolean {
  if (a.type !== b.type) return false;
  if (a.id === b.id) return true;
  const left = secretOf(a);
  return left !== null && left === secretOf(b);
}

export function mergeAccounts(
  existing: AccountItem,
  incoming: AccountItem,
): AccountMerge {
  const methods = [...existing.methods];
  const added: LoginMethod[] = [];
  const duplicates: LoginMethod[] = [];
  const conflicts: PasswordMethod[] = [];

  for (const method of incoming.methods) {
    if (methods.some((held) => sameMethod(held, method))) {
      duplicates.push(method);
      continue;
    }
    if (
      method.type === "password" &&
      methods.some((held) => held.type === "password")
    ) {
      conflicts.push(method);
      continue;
    }
    // A method id is only unique within its account; one that collides with a
    // different method is re-minted rather than overwritten.
    const taken = methods.some((held) => held.id === method.id);
    const landed: LoginMethod = taken
      ? { ...method, id: newMethodId(existing.id, method.type) }
      : method;
    methods.push(landed);
    added.push(landed);
  }

  return {
    account: { ...existing, methods },
    added,
    duplicates,
    conflicts,
  };
}

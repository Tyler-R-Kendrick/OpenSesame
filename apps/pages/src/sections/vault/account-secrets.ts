/**
 * What the account editor does to a password method (ADR 0173, ADR 0174).
 *
 * A method keeps one secret, in the clear in the sealed body: the password, or
 * for an algorithmic one the root the password is computed from. A pepper is
 * never held here: *Include pepper* only says that the password has a slot, and
 * where (`pepperAt`); the pepper itself is the person's, not asked for and not
 * stored.
 */

import {
  defaultGenerator,
  newSecretFor,
} from "@opensesame/app-core/lib/vault/generators/index.js";
import type { OfferedGeneratorId } from "@opensesame/app-core/lib/vault/generators/index.js";
import {
  type AccountItem,
  type LoginMethod,
  type PasswordMethod,
  completePassword,
  isPepperPosition,
  producePassword,
} from "@opensesame/vault-core";

/** The password the editor shows: what the facade produces before any pepper. */
export function shownPassword(method: PasswordMethod): string {
  const produced = producePassword(method);
  if (produced.status === "ok") return produced.password;
  return produced.status === "slotted"
    ? `${produced.head}${produced.tail}`
    : "";
}

/** A typed value: it replaces what the method kept, and makes the method a typed one. */
export function holdValue(
  method: PasswordMethod,
  value: string,
): PasswordMethod {
  const { sealed: _sealed, ...rest } = method;
  return { ...rest, generator: { id: "manual" }, secret: value };
}

/**
 * A different generator: a new secret for it, which is the root for an
 * algorithmic one. A typed password stays what it was.
 */
export function switchGenerator(
  method: PasswordMethod,
  id: OfferedGeneratorId,
): PasswordMethod {
  const { sealed: _sealed, ...rest } = method;
  const generator = defaultGenerator(id);
  const kept =
    id === "manual" ? shownPassword(method) : newSecretFor(generator);
  return { ...rest, generator, secret: kept };
}

/**
 * A fresh value from the method's own random generator. Null when there is
 * nothing to make: the rules choose no class (the options are the problem, not
 * a message), or the generator is algorithmic, which is rotated instead.
 */
export function regenerate(method: PasswordMethod): PasswordMethod | null {
  const { generator } = method;
  if (generator.id !== "rules" && generator.id !== "passphrase") return null;
  try {
    return { ...method, secret: newSecretFor(generator) };
  } catch {
    return null;
  }
}

/** An algorithmic password's next one: the counter moves, the root stays. */
export function rotate(method: PasswordMethod): PasswordMethod | null {
  const { generator } = method;
  if (generator.id !== "derived") return null;
  return {
    ...method,
    generator: { ...generator, counter: generator.counter + 1 },
  };
}

/** *Include pepper* on or off. Turning it off forgets where it went; nothing else changes. */
export function setPepper(method: PasswordMethod, on: boolean): PasswordMethod {
  const { pepperAt: _at, ...rest } = method;
  return on ? { ...method, pepper: true } : { ...rest, pepper: false };
}

/** Where the pepper goes. Text that is not a position is not kept; empty means last. */
export function setPepperAt(
  method: PasswordMethod,
  text: string,
): PasswordMethod | null {
  if (!isPepperPosition(text)) return null;
  const { pepperAt: _at, ...rest } = method;
  return text.trim() === "" ? rest : { ...rest, pepperAt: text.trim() };
}

function savedMethod(
  existing: AccountItem | undefined,
  id: string,
): PasswordMethod | undefined {
  return existing?.methods.find(
    (candidate): candidate is PasswordMethod =>
      candidate.type === "password" && candidate.id === id,
  );
}

/** The password a method produces whole, or what it leaves of it, as text to compare. */
function producedKey(method: PasswordMethod): string {
  const produced = producePassword(method);
  return `${produced.status}\u0000${completePassword(produced) ?? shownPassword(method)}`;
}

/**
 * The account as it is saved: `changedAt` moves when a password did, whether
 * it was typed, made again or computed under a new counter.
 */
export function settleForSave(
  account: AccountItem,
  existing: AccountItem | undefined,
): AccountItem {
  const now = new Date().toISOString();
  const methods = account.methods.map((method): LoginMethod => {
    if (method.type !== "password") return method;
    const before = savedMethod(existing, method.id);
    const changed =
      before === undefined || producedKey(before) !== producedKey(method);
    return changed ? { ...method, changedAt: now } : method;
  });
  return { ...account, methods };
}

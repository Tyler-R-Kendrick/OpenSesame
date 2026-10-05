/**
 * The pepper-aware password API (ADR 0172 §4, ADR 0173). A secret with *Include
 * pepper* is sealed under a pepper the person types each time it is used
 * (OPAQUE, `opaque-seal.ts`). The secret is the password for a stored
 * generator and the root a derived password is computed from for `derived`; a
 * Sphinx password (ADR 0172, read only) is computed from a master input. The
 * pepper, the master input and the password never appear in an error message.
 */

import {
  type AccountItem,
  type PasswordMethod,
  type PepperSeal,
  WrongPepperError,
  deriveCharacters,
  openWithPepper,
  pepperBinding,
} from "@opensesame/vault-core";
import { openWithOpaque, sealWithOpaque } from "./opaque-seal.js";
import {
  type OprfEvaluator,
  sphinxPassword,
  vaultEvaluator,
} from "./sphinx.js";

/** What the person must type: the pepper (or, for sphinx, the master input). */
export type PepperAsk = () => Promise<string>;

function unsealed(method: PasswordMethod): Omit<PasswordMethod, "sealed"> {
  const { sealed: _sealed, ...rest } = method;
  return rest;
}

function refuseSphinx(method: PasswordMethod): void {
  if (method.generator.id === "sphinx") {
    throw new Error("A Sphinx password is computed, never stored.");
  }
}

/** Opens either seal: v1 (ADR 0172, PBKDF2) still opens, v2 (OPAQUE) is what is written. */
function openSeal(
  sealed: PepperSeal,
  pepper: string,
  binding: string,
): Promise<string> {
  return sealed.v === 2
    ? openWithOpaque(sealed, pepper, binding)
    : openWithPepper(sealed, pepper, binding);
}

async function open(
  accountId: string,
  method: PasswordMethod,
  pepper: string,
): Promise<string> {
  if (!method.sealed || pepper === "") throw new WrongPepperError();
  return openSeal(method.sealed, pepper, pepperBinding(accountId, method.id));
}

/**
 * Store what a method keeps: the password, or for `derived` its root secret
 * (`mintRootSecret()`), in the clear or sealed under the pepper.
 */
export async function storePassword(
  accountId: string,
  method: PasswordMethod,
  password: string,
  pepper: string | null,
  now: Date = new Date(),
): Promise<PasswordMethod> {
  refuseSphinx(method);
  const changedAt = now.toISOString();
  if (!method.pepper) {
    return { ...unsealed(method), secret: password, changedAt };
  }
  if (pepper === null || pepper === "") {
    throw new Error("A pepper is required to store this password.");
  }
  const sealed = await sealWithOpaque(
    password,
    pepper,
    pepperBinding(accountId, method.id),
  );
  return { ...method, secret: "", sealed, changedAt };
}

export async function enablePepper(
  accountId: string,
  method: PasswordMethod,
  currentPassword: string,
  pepper: string,
): Promise<PasswordMethod> {
  refuseSphinx(method);
  const sealed = await sealWithOpaque(
    currentPassword,
    pepper,
    pepperBinding(accountId, method.id),
  );
  return { ...method, pepper: true, secret: "", sealed };
}

export async function disablePepper(
  accountId: string,
  method: PasswordMethod,
  pepper: string,
): Promise<PasswordMethod> {
  refuseSphinx(method);
  if (!method.sealed) return { ...unsealed(method), pepper: false };
  const secret = await open(accountId, method, pepper);
  return { ...unsealed(method), pepper: false, secret };
}

export async function usePassword(
  account: Pick<AccountItem, "id" | "username">,
  method: PasswordMethod,
  ask: PepperAsk,
  evaluator?: OprfEvaluator,
): Promise<string> {
  const { generator } = method;
  if (generator.id === "sphinx") {
    const master = await ask();
    return sphinxPassword(
      {
        master,
        realm: generator.realm,
        username: account.username,
        counter: generator.counter,
        rules: generator.rules,
      },
      evaluator ?? vaultEvaluator(generator.oprfKeyB64),
    );
  }
  const secret =
    !method.pepper || !method.sealed
      ? method.secret
      : await open(account.id, method, await ask());
  if (generator.id !== "derived") return secret;
  return secret === ""
    ? ""
    : deriveCharacters(secret, generator.counter, generator.rules);
}

/** True when `pepper` opens the seal. False when it does not, or there is no seal. */
export async function checkPepper(
  accountId: string,
  method: PasswordMethod,
  pepper: string,
): Promise<boolean> {
  if (!method.sealed) return false;
  try {
    await open(accountId, method, pepper);
    return true;
  } catch (error) {
    if (error instanceof WrongPepperError) return false;
    throw error;
  }
}

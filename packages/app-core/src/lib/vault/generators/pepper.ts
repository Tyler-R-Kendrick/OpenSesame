/**
 * The pepper-aware password API (ADR 0171 §4, §5). A password with *Include
 * pepper* is sealed under a pepper the person types each time it is used; a
 * Sphinx password is never stored at all. The pepper, the master input and the
 * password never appear in an error message.
 */

import {
  type AccountItem,
  type PasswordMethod,
  WrongPepperError,
  openWithPepper,
  pepperBinding,
  sealWithPepper,
} from "@opensesame/vault-core";
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

async function open(
  accountId: string,
  method: PasswordMethod,
  pepper: string,
): Promise<string> {
  if (!method.sealed || pepper === "") throw new WrongPepperError();
  return openWithPepper(
    method.sealed,
    pepper,
    pepperBinding(accountId, method.id),
  );
}

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
  const sealed = await sealWithPepper(
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
  const sealed = await sealWithPepper(
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
  if (!method.pepper || !method.sealed) return method.secret;
  return open(account.id, method, await ask());
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

/**
 * Converting what an older version made from a typed pepper (ADR 0174 §5).
 *
 * Version ADR 0172 asked the person for a pepper, sealed a password under it, or
 * computed a Sphinx password from a master input typed at each use. A pepper is
 * not asked for and not stored now, and neither can be produced without it: a
 * method that holds either is `legacy` to the facade. This opens one **once**,
 * with the secret the person chose then, and writes what it was as an ordinary
 * stored password. The input is used for that one call and kept by nobody; the
 * method that comes out has no seal, no master input and no pepper.
 */

import {
  type AccountItem,
  type PasswordMethod,
  WrongPepperError,
  openWithPepper,
  pepperBinding,
} from "@opensesame/vault-core";
import { sphinxPassword, vaultEvaluator } from "./sphinx.js";

/** Whether a method is one an older version made, which only a conversion can read. */
export function isLegacyMethod(method: PasswordMethod): boolean {
  return method.sealed !== undefined || method.generator.id === "sphinx";
}

async function openLegacy(
  account: Pick<AccountItem, "id" | "username">,
  method: PasswordMethod,
  secret: string,
): Promise<string> {
  const { generator } = method;
  if (generator.id === "sphinx") {
    return sphinxPassword(
      {
        master: secret,
        realm: generator.realm,
        username: account.username,
        counter: generator.counter,
        rules: generator.rules,
      },
      vaultEvaluator(generator.oprfKeyB64),
    );
  }
  if (!method.sealed || secret === "") throw new WrongPepperError();
  return openWithPepper(
    method.sealed,
    secret,
    pepperBinding(account.id, method.id),
  );
}

/**
 * The method as a stored password, made from the one the person's old pepper
 * (or Sphinx master input) opens. Throws `WrongPepperError` for a sealed
 * password that the input does not open. A Sphinx input cannot be checked, so
 * a wrong one gives a different password; the caller shows the result before it
 * is kept.
 */
export async function convertLegacyMethod(
  account: Pick<AccountItem, "id" | "username">,
  method: PasswordMethod,
  secret: string,
  now: Date = new Date(),
): Promise<PasswordMethod> {
  const password = await openLegacy(account, method, secret);
  return {
    id: method.id,
    type: "password",
    generator: { id: "manual" },
    pepper: false,
    secret: password,
    changedAt: now.toISOString(),
  };
}

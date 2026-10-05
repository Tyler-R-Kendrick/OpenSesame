/**
 * Reading an account's password where a person can be asked for something
 * first (ADR 0172 §4). The command bar, a live session and the like call
 * `readAccountPassword`; a consumer that cannot prompt (health, SOPS, a list)
 * reads `accountPlainPassword` and treats a peppered password as absent.
 *
 * Nothing here logs, returns or keeps a pepper: it is asked for at most once
 * per read, handed to the generator, and dropped.
 */

import {
  type AccountItem,
  type PasswordMethod,
  WrongPepperError,
  needsPepper,
  passwordMethod,
  plainPassword,
} from "@opensesame/vault-core";
import { usePassword } from "./vault/generators/index.js";

/**
 * Ask the person for a pepper. `null` is a cancel: nothing is read, nothing is
 * copied. A surface with no way to ask passes nothing at all.
 */
export type AskPepper = () => Promise<string | null>;

export type PasswordReading =
  /** The password, in the clear for this one use. */
  | { status: "ok"; password: string }
  /** No password to give: none set, or one that needs a pepper nobody can ask for. */
  | { status: "absent" }
  | { status: "cancelled" }
  | { status: "wrong" };

class Cancelled extends Error {}

/** One method's password, asking for its pepper only when it needs one. */
export async function readMethodPassword(
  account: Pick<AccountItem, "id" | "username">,
  method: PasswordMethod,
  askPepper?: AskPepper,
): Promise<PasswordReading> {
  if (!needsPepper(method)) {
    // A stored password, or a derived one whose root is in the clear.
    const password = plainPassword(method) ?? "";
    return password === "" ? { status: "absent" } : { status: "ok", password };
  }
  // No prompt available: never guess, never read the sealed form.
  if (askPepper === undefined) return { status: "absent" };
  let asked = false;
  const ask = async (): Promise<string> => {
    // The generator may ask again for a retry; one read is one question.
    if (asked) throw new Cancelled();
    asked = true;
    const pepper = await askPepper();
    if (pepper === null) throw new Cancelled();
    return pepper;
  };
  try {
    const password = await usePassword(
      { id: account.id, username: account.username },
      method,
      ask,
    );
    return password === "" ? { status: "absent" } : { status: "ok", password };
  } catch (error) {
    if (error instanceof Cancelled) return { status: "cancelled" };
    if (error instanceof WrongPepperError) return { status: "wrong" };
    throw error;
  }
}

/** The account's first password method, read as `readMethodPassword` reads it. */
export async function readAccountPassword(
  account: AccountItem,
  askPepper?: AskPepper,
): Promise<PasswordReading> {
  const method = passwordMethod(account);
  if (method === undefined) return { status: "absent" };
  return readMethodPassword(account, method, askPepper);
}

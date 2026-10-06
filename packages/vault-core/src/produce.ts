/**
 * Producing a password (ADR 0174): the one facade every runtime calls.
 *
 * Copy to the clipboard, fill a field, hand a password to the terminal, the
 * agent surfaces, a health score, an export: each asks `producePassword` and
 * none of them knows how a password is made. A method may keep the password,
 * hold the root an algorithm computes it from, or leave a slot in it for a
 * secret of the person's own; this is the only module that opens any of that,
 * so a technique changes here and nowhere else (`produce.test.ts` in app-core
 * fails on any other reader).
 *
 * A pepper is not asked for and not stored. A method that includes one yields
 * the password in two parts around the slot, and the person supplies the middle
 * where they use it.
 */

import type { AccountItem, PasswordMethod } from "./account.js";
import { passwordMethod } from "./account.js";
import { deriveCharacters } from "./derive.js";
import { splitAtPepper } from "./pepper-position.js";

export type ProducedPassword =
  /** The whole password. */
  | { status: "ok"; password: string }
  /** The password around the slot a pepper of the person's own fills. */
  | { status: "slotted"; head: string; tail: string; at: string }
  /** Nothing to produce: no method, or nothing kept in it. */
  | { status: "absent" }
  /**
   * Made by an older version, from a pepper or master input the product asked
   * for. It cannot be produced until it is converted once (ADR 0174 §5).
   */
  | { status: "legacy" };

/** What the method keeps or computes, before any pepper: null for an older, unconvertible one. */
function basePassword(method: PasswordMethod): string | null {
  const { generator } = method;
  if (method.sealed || generator.id === "sphinx") return null;
  if (generator.id === "derived") {
    return method.secret === ""
      ? ""
      : deriveCharacters(method.secret, generator.counter, generator.rules);
  }
  return method.secret;
}

/** Produce one method's password. Synchronous: nothing here waits on a person. */
export function producePassword(method: PasswordMethod): ProducedPassword {
  const password = basePassword(method);
  if (password === null) return { status: "legacy" };
  if (password === "") return { status: "absent" };
  if (!method.pepper) return { status: "ok", password };
  const { head, tail } = splitAtPepper(password, method.pepperAt);
  return { status: "slotted", head, tail, at: method.pepperAt ?? "" };
}

/** The account's first password method, produced. */
export function produceAccountPassword(item: AccountItem): ProducedPassword {
  const method = passwordMethod(item);
  return method === undefined ? { status: "absent" } : producePassword(method);
}

/** The whole password, when producing it needs nothing from the person. */
export function completePassword(produced: ProducedPassword): string | null {
  return produced.status === "ok" ? produced.password : null;
}

/**
 * What a surface puts out first, and what must follow the person's pepper.
 * `later` is empty when the pepper goes last, which is the usual place. Null
 * when there is nothing to put out.
 */
export function handoff(
  produced: ProducedPassword,
): { now: string; later: string } | null {
  if (produced.status === "ok") return { now: produced.password, later: "" };
  if (produced.status === "slotted") {
    return { now: produced.head, later: produced.tail };
  }
  return null;
}

/** Whether a generator computes the password from parameters rather than keeping one. */
export function isAlgorithmic(method: PasswordMethod): boolean {
  return method.generator.id === "derived" || method.generator.id === "sphinx";
}

/**
 * The password a file may hold for a method: the one it keeps. An algorithmic
 * method keeps none, so its file carries the parameters it is computed from
 * and this is empty (ADR 0174 §4): a file never holds a generated password.
 */
export function filePassword(method: PasswordMethod): string {
  return isAlgorithmic(method) || method.sealed ? "" : method.secret;
}

/** The account's first password method's `filePassword`. */
export function accountFilePassword(item: AccountItem): string {
  const method = passwordMethod(item);
  return method === undefined ? "" : filePassword(method);
}

/**
 * What the account editor does to a password method's secret (ADR 0171 §4).
 *
 * A password that is peppered is never in the draft item: the draft holds
 * `secret: ""` and the sealed envelope. The plaintext the person typed or
 * generated lives in the editor's `PlainMap` (component state) until Save,
 * where it is sealed under a pepper asked for once and dropped. A password
 * without a pepper is the draft's own `secret`, as it always was.
 */

import {
  defaultGenerator,
  disablePepper,
  enablePepper,
  generateStored,
  storePassword,
} from "@opensesame/app-core/lib/vault/generators/index.js";
import {
  type AccountItem,
  type LoginMethod,
  type PasswordGeneratorId,
  type PasswordMethod,
  hostOf,
  plainPassword,
} from "@opensesame/vault-core";
import type { PepperAskFn } from "../../components/PepperPrompt.js";

/** A password the editor knows in the clear, by method id. `dirty` means it is new. */
export type PlainEntry = { value: string; dirty: boolean };
export type PlainMap = Readonly<Record<string, PlainEntry>>;

export type MethodEdit = {
  method: PasswordMethod;
  /** The method's entry in the `PlainMap` after the edit; `null` removes it. */
  plain: PlainEntry | null;
};

/** The host of the first website, else the item id. Fixed when Sphinx is chosen. */
export function realmOf(account: AccountItem): string {
  for (const entry of account.uris) {
    const host = hostOf(entry.uri);
    if (host !== "") return host;
  }
  return account.id;
}

function withoutSeal(method: PasswordMethod): PasswordMethod {
  const { sealed: _sealed, ...rest } = method;
  return rest;
}

function isStored(id: PasswordGeneratorId): boolean {
  return id === "rules" || id === "passphrase";
}

/** The password as the editor knows it: its plaintext entry, else the clear secret. */
export function knownPassword(
  method: PasswordMethod,
  plain: PlainMap,
): string | null {
  const entry = plain[method.id];
  if (entry) return entry.value;
  return plainPassword(method);
}

/** A new value for a method: peppered ones keep it in `plain`, the rest in `secret`. */
export function holdValue(method: PasswordMethod, value: string): MethodEdit {
  if (method.pepper) {
    return {
      method: { ...method, secret: "" },
      plain: { value, dirty: true },
    };
  }
  return {
    method: { ...withoutSeal(method), secret: value },
    plain: null,
  };
}

export function switchGenerator(
  account: AccountItem,
  method: PasswordMethod,
  id: PasswordGeneratorId,
  plain: PlainMap,
): MethodEdit {
  const generator = defaultGenerator(id, { realm: realmOf(account) });
  if (generator.id === "sphinx") {
    return {
      method: { ...withoutSeal(method), generator, pepper: true, secret: "" },
      plain: null,
    };
  }
  const wasSphinx = method.generator.id === "sphinx";
  const next: PasswordMethod = {
    ...method,
    generator,
    pepper: wasSphinx ? false : method.pepper,
  };
  if (generator.id === "manual") {
    // The password stays what it was; the person types over it.
    const kept = wasSphinx ? "" : (knownPassword(method, plain) ?? "");
    return next.pepper
      ? {
          method: { ...next, secret: "" },
          plain:
            plain[method.id] ??
            (kept === "" ? null : { value: kept, dirty: false }),
        }
      : { method: { ...withoutSeal(next), secret: kept }, plain: null };
  }
  if (!isStored(generator.id)) return { method: next, plain: null };
  return holdValue(next, generateStored(generator));
}

/** A fresh value from the method's own generator. Unchanged when the rules cannot make one. */
export function regenerate(method: PasswordMethod): MethodEdit | null {
  const { generator } = method;
  if (generator.id !== "rules" && generator.id !== "passphrase") return null;
  try {
    return holdValue(method, generateStored(generator));
  } catch {
    // No character class is chosen: the options are the problem, not a message.
    return null;
  }
}

/** Include pepper turned on: ask twice, then seal the password the editor holds. */
export async function pepperOn(
  account: AccountItem,
  method: PasswordMethod,
  plain: PlainMap,
  ask: PepperAskFn,
): Promise<MethodEdit> {
  const pepper = await ask("set", "Set pepper");
  const current = knownPassword(method, plain) ?? "";
  const sealed = await enablePepper(account.id, method, current, pepper);
  return { method: sealed, plain: { value: current, dirty: false } };
}

/** Include pepper turned off. Asks only when the editor does not already hold the password. */
export async function pepperOff(
  account: AccountItem,
  method: PasswordMethod,
  plain: PlainMap,
  ask: PepperAskFn,
): Promise<MethodEdit> {
  const entry = plain[method.id];
  if (entry) {
    return {
      method: { ...withoutSeal(method), pepper: false, secret: entry.value },
      plain: null,
    };
  }
  const pepper = await ask("enter", "Remove pepper");
  return {
    method: await disablePepper(account.id, method, pepper),
    plain: null,
  };
}

/**
 * The account as it is saved: peppered passwords sealed (the pepper is asked
 * once, and only when a peppered password is new), no peppered plaintext, no
 * seal on a plain or Sphinx method, and `changedAt` moved when a password did.
 */
export async function sealForSave(
  account: AccountItem,
  existing: AccountItem | undefined,
  plain: PlainMap,
  ask: PepperAskFn,
): Promise<AccountItem> {
  const isDirty = (method: LoginMethod): boolean =>
    method.type === "password" &&
    method.pepper &&
    method.generator.id !== "sphinx" &&
    plain[method.id]?.dirty === true;
  const pepper = account.methods.some(isDirty)
    ? await ask("set", "Set pepper")
    : null;
  const methods: LoginMethod[] = [];
  for (const method of account.methods) {
    if (method.type !== "password") {
      methods.push(method);
      continue;
    }
    if (method.generator.id === "sphinx") {
      methods.push({ ...withoutSeal(method), pepper: true, secret: "" });
    } else if (method.pepper) {
      const entry = plain[method.id];
      methods.push(
        isDirty(method) && entry
          ? await storePassword(account.id, method, entry.value, pepper)
          : { ...method, secret: "" },
      );
    } else {
      const before = existing?.methods.find(
        (candidate): candidate is PasswordMethod =>
          candidate.type === "password" && candidate.id === method.id,
      );
      const was = before ? plainPassword(before) : null;
      const changed = was !== null && was !== method.secret;
      methods.push(
        changed
          ? await storePassword(account.id, method, method.secret, null)
          : withoutSeal(method),
      );
    }
  }
  return { ...account, methods };
}

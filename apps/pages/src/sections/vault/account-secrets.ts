/**
 * What the account editor does to a password method's secret (ADR 0172 §4,
 * ADR 0173).
 *
 * A method's secret is its password, or for `derived` the root the password is
 * computed from. One that is peppered is never in the draft item: the draft
 * holds `secret: ""` and the sealed envelope. The plaintext the person typed
 * or generated lives in the editor's `PlainMap` (component state) until Save,
 * where it is sealed under a pepper asked for once and dropped. One without a
 * pepper is the draft's own `secret`, as it always was.
 */

import {
  defaultGenerator,
  disablePepper,
  enablePepper,
  generateStored,
  storePassword,
} from "@opensesame/app-core/lib/vault/generators/index.js";
import type { OfferedGeneratorId } from "@opensesame/app-core/lib/vault/generators/index.js";
import {
  type AccountItem,
  type LoginMethod,
  type PasswordMethod,
  deriveCharacters,
  mintRootSecret,
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

function withoutSeal(method: PasswordMethod): PasswordMethod {
  const { sealed: _sealed, ...rest } = method;
  return rest;
}

/**
 * What the method keeps, as the editor knows it: its plaintext entry, else the
 * clear secret. For `derived` that is the root. Null when it is sealed and the
 * editor does not hold it.
 */
export function knownSecret(
  method: PasswordMethod,
  plain: PlainMap,
): string | null {
  const entry = plain[method.id];
  if (entry) return entry.value;
  return method.pepper || method.generator.id === "sphinx"
    ? null
    : method.secret;
}

/** The password as the editor knows it: what a derived method computes, else the secret itself. */
export function knownPassword(
  method: PasswordMethod,
  plain: PlainMap,
): string | null {
  const secret = knownSecret(method, plain);
  if (secret === null) return null;
  const { generator } = method;
  if (generator.id !== "derived") return secret;
  return secret === ""
    ? ""
    : deriveCharacters(secret, generator.counter, generator.rules);
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
  method: PasswordMethod,
  id: OfferedGeneratorId,
  plain: PlainMap,
): MethodEdit {
  const generator = defaultGenerator(id);
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
  if (generator.id === "derived") return holdValue(next, mintRootSecret());
  if (generator.id !== "rules" && generator.id !== "passphrase") {
    return { method: next, plain: null };
  }
  return holdValue(next, generateStored(generator));
}

/**
 * A fresh value from the method's own generator. Null when there is nothing to
 * make: the rules choose no class (the options are the problem, not a
 * message), or the generator is `derived`, which is rotated instead.
 */
export function regenerate(method: PasswordMethod): MethodEdit | null {
  const { generator } = method;
  if (generator.id !== "rules" && generator.id !== "passphrase") return null;
  try {
    return holdValue(method, generateStored(generator));
  } catch {
    return null;
  }
}

/** A derived password's next one: the counter moves, the root and the pepper stay. */
export function rotate(
  method: PasswordMethod,
  entry: PlainEntry | undefined,
): MethodEdit | null {
  const { generator } = method;
  if (generator.id !== "derived") return null;
  return {
    method: {
      ...method,
      generator: { ...generator, counter: generator.counter + 1 },
    },
    plain: entry ?? null,
  };
}

/** Include pepper turned on: ask twice, then seal the password the editor holds. */
export async function pepperOn(
  account: AccountItem,
  method: PasswordMethod,
  plain: PlainMap,
  ask: PepperAskFn,
): Promise<MethodEdit> {
  const pepper = await ask("set", "Set pepper");
  const current = knownSecret(method, plain) ?? "";
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

function savedMethod(
  existing: AccountItem | undefined,
  id: string,
): PasswordMethod | undefined {
  return existing?.methods.find(
    (candidate): candidate is PasswordMethod =>
      candidate.type === "password" && candidate.id === id,
  );
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
      if (isDirty(method) && entry) {
        methods.push(
          await storePassword(account.id, method, entry.value, pepper),
        );
      } else {
        const before = savedMethod(existing, method.id);
        // A derived password is rotated or re-shaped without its root being
        // typed again: its generator moved, so the password did.
        const moved =
          method.generator.id === "derived" &&
          before !== undefined &&
          JSON.stringify(before.generator) !== JSON.stringify(method.generator);
        const kept: PasswordMethod = { ...method, secret: "" };
        if (moved) kept.changedAt = new Date().toISOString();
        methods.push(kept);
      }
    } else {
      const before = savedMethod(existing, method.id);
      const was = before ? plainPassword(before) : null;
      const changed = was !== null && was !== plainPassword(method);
      methods.push(
        changed
          ? await storePassword(account.id, method, method.secret, null)
          : withoutSeal(method),
      );
    }
  }
  return { ...account, methods };
}

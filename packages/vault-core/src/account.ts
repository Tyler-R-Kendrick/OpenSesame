/**
 * The account item (ADR 0168). An account is a username or id at one or more
 * sites, plus the login methods that open it. A password is one method among
 * several; it is never the item.
 *
 * Everything here lives inside the sealed body. The only secret a method can
 * hold in the clear is one the person chose to keep in the clear: a password
 * with *Include pepper* is stored sealed under its pepper, and a Sphinx
 * password is stored as nothing but its OPRF key.
 */

import { isJsonObject, overlapCast } from "@opensesame/os-domain";
import type { SealedBlob } from "./crypto.js";
import type { LoginUri } from "./login-uri.js";
import type { BaseItem, ReenrollState } from "./model.js";

export const LOGIN_METHOD_TYPES = [
  "password",
  "api-key",
  "token",
  "oauth",
  "authenticator",
] as const;
export type LoginMethodType = (typeof LOGIN_METHOD_TYPES)[number];

/**
 * How a password is made. `manual` is typed by the person; every other
 * generator produces it. `sphinx` is the only one that is never stored: it is
 * recomputed at each use from a master input the person types and a key that
 * stays in the vault (RFC 9497 OPRF).
 */
export const PASSWORD_GENERATOR_IDS = [
  "rules",
  "passphrase",
  "sphinx",
  "manual",
] as const;
export type PasswordGeneratorId = (typeof PASSWORD_GENERATOR_IDS)[number];

export type CharacterRules = {
  length: number;
  lower: boolean;
  upper: boolean;
  digits: boolean;
  symbols: boolean;
  avoidAmbiguous: boolean;
  /** Bitwarden-style floors. Zero means "no floor beyond one per class". */
  minDigits: number;
  minSymbols: number;
};

export type RulesGenerator = { id: "rules" } & CharacterRules;

export type PassphraseGenerator = {
  id: "passphrase";
  words: number;
  separator: string;
  capitalize: boolean;
  includeNumber: boolean;
};

export type SphinxGenerator = {
  id: "sphinx";
  /** The shape of the password the OPRF output is encoded into. */
  rules: CharacterRules;
  /**
   * Fixed when the generator is chosen (the first site's host, else the item
   * id) and never re-derived from the sites: editing a URL must not change a
   * password.
   */
  realm: string;
  /** Bumped to rotate the password without changing the master input. */
  counter: number;
  /** The OPRF server key `k` (ristretto255), base64. Stays in the sealed body. */
  oprfKeyB64: string;
};

export type ManualGenerator = { id: "manual" };

export type PasswordGenerator =
  | RulesGenerator
  | PassphraseGenerator
  | SphinxGenerator
  | ManualGenerator;

/**
 * A password sealed under a pepper: PBKDF2-SHA256 over the pepper, AES-GCM
 * over the password, bound to the account and method ids so a seal cannot be
 * moved to another method. The pepper itself is never stored anywhere.
 */
export type PepperSeal = {
  v: 1;
  kdf: {
    alg: "PBKDF2-SHA256";
    saltB64: string;
    iterations: number;
  };
  seal: SealedBlob;
};

export type PasswordMethod = {
  id: string;
  type: "password";
  generator: PasswordGenerator;
  /**
   * *Include pepper.* When set, the person is asked for the pepper each time
   * the password is used. For `sphinx` it is the master input and is always
   * set. Otherwise `secret` is empty and `sealed` holds the password.
   */
  pepper: boolean;
  /** The password, when it is kept in the clear (no pepper, not sphinx). */
  secret: string;
  /** The password, when `pepper` is set and the generator is not `sphinx`. */
  sealed?: PepperSeal | undefined;
  changedAt: string;
};

export type ApiKeyMethod = {
  id: string;
  type: "api-key";
  key: string;
  /** Header or query name the key travels in, e.g. `X-Api-Key`. */
  header: string;
};

export type TokenMethod = {
  id: string;
  type: "token";
  token: string;
  /** ISO time the token lapses. Empty for none. */
  expiresAt: string;
};

export type OAuthMethod = {
  id: string;
  type: "oauth";
  clientId: string;
  clientSecret: string;
  tokenUrl: string;
  /** Space-separated, as OAuth writes them. */
  scopes: string;
  refreshToken: string;
};

export type AuthenticatorMethod = {
  id: string;
  type: "authenticator";
  /** Base32 TOTP seed, or an otpauth:// URI. */
  secret: string;
};

export type LoginMethod =
  | PasswordMethod
  | ApiKeyMethod
  | TokenMethod
  | OAuthMethod
  | AuthenticatorMethod;

export type AccountItem = BaseItem & {
  kind: "account";
  /** The username, email or id the sites know this account by. */
  username: string;
  uris: LoginUri[];
  methods: LoginMethod[];
  resetEmailId?: string;
  supersededById?: string;
  retiredAt?: string | null;
  reenrollState?: ReenrollState;
};

/**
 * The shape a vault carried before ADR 0168. It is read, never written: a body
 * is normalized to accounts on open (`normalizeLegacyItems`).
 */
export type LegacyLoginItem = Omit<BaseItem, "kind"> & {
  kind: "login";
  username: string;
  password: string;
  totp: string;
  uris: LoginUri[];
  passwordChangedAt: string;
  resetEmailId?: string;
  supersededById?: string;
  retiredAt?: string | null;
  reenrollState?: ReenrollState;
};

export const DEFAULT_RULES: CharacterRules = {
  length: 20,
  lower: true,
  upper: true,
  digits: true,
  symbols: true,
  // spec/conformance/password-policy.json: the default every target shares.
  avoidAmbiguous: true,
  minDigits: 0,
  minSymbols: 0,
};

export function methodsOfType<T extends LoginMethodType>(
  item: AccountItem,
  type: T,
): Extract<LoginMethod, { type: T }>[] {
  return item.methods.filter(
    (method): method is Extract<LoginMethod, { type: T }> =>
      method.type === type,
  );
}

export function passwordMethod(item: AccountItem): PasswordMethod | undefined {
  return methodsOfType(item, "password")[0];
}

export function authenticatorMethod(
  item: AccountItem,
): AuthenticatorMethod | undefined {
  return methodsOfType(item, "authenticator")[0];
}

/** A password that can be shown or filled with no question asked. */
export function plainPassword(method: PasswordMethod): string | null {
  if (method.pepper || method.generator.id === "sphinx") return null;
  return method.secret;
}

/** True when using the password means asking the person for something first. */
export function needsPepper(method: PasswordMethod): boolean {
  return method.pepper || method.generator.id === "sphinx";
}

/** The TOTP seed of the account's first authenticator method, else empty. */
export function accountTotp(item: AccountItem): string {
  return authenticatorMethod(item)?.secret ?? "";
}

/**
 * The account's password when nothing needs asking, else `""`. Callers that
 * cannot prompt (health, export, a list) read this and treat a peppered
 * password as absent rather than guessing.
 */
export function accountPlainPassword(item: AccountItem): string {
  const method = passwordMethod(item);
  return method ? (plainPassword(method) ?? "") : "";
}

export function newMethodId(accountId: string, type: LoginMethodType): string {
  return `${accountId}:${type}:${crypto.randomUUID()}`;
}

export function manualPassword(
  methodId: string,
  secret: string,
  changedAt: string,
): PasswordMethod {
  return {
    id: methodId,
    type: "password",
    generator: { id: "manual" },
    pepper: false,
    secret,
    changedAt,
  };
}

/**
 * A legacy login becomes an account with the same sites and username, a manual
 * password method holding its password, and an authenticator method for its
 * seed. Method ids derive from the item id so two devices that migrate the same
 * login produce the same account and a merge sees no difference.
 */
export function migrateLegacyLogin(legacy: LegacyLoginItem): AccountItem {
  const { password, totp, passwordChangedAt, ...rest } = legacy;
  const methods: LoginMethod[] = [];
  if (password !== "" || totp === "") {
    methods.push(
      manualPassword(`${legacy.id}:password`, password, passwordChangedAt),
    );
  }
  if (totp !== "") {
    methods.push({
      id: `${legacy.id}:authenticator`,
      type: "authenticator",
      secret: totp,
    });
  }
  return { ...rest, kind: "account", methods };
}

export function isLegacyLogin<T>(value: T): value is T & LegacyLoginItem {
  const record = overlapCast(value);
  return isJsonObject(record) && record.kind === "login";
}

/**
 * Every legacy login in a list becomes an account; everything else passes
 * through untouched. Idempotent, so a body that is read, written and read again
 * (or merged from a device that already migrated) is stable.
 */
export function normalizeLegacyItems<T>(
  items: readonly T[],
): (T | AccountItem)[] {
  return items.map((item) =>
    isLegacyLogin(item) ? migrateLegacyLogin(item) : item,
  );
}

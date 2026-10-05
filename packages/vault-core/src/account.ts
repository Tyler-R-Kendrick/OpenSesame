/**
 * The account item (ADR 0172). An account is a username or id at one or more
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
 * How a password is made. `manual` is typed by the person. `rules` and
 * `passphrase` make a password and store it. `derived` stores only a root
 * secret and computes the password from it at every use (ADR 0173); with
 * *Include pepper* the root is sealed under a pepper through OPAQUE (RFC 9807).
 * `sphinx` is the generator ADR 0172 shipped: a master input and an OPRF key
 * (RFC 9497). It is read, never offered: a vault that holds one still opens it.
 */
export const PASSWORD_GENERATOR_IDS = [
  "derived",
  "rules",
  "passphrase",
  "manual",
  "sphinx",
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

export type DerivedGenerator = {
  id: "derived";
  /** The shape the computed password is encoded into. */
  rules: CharacterRules;
  /** Bumped to rotate the password without touching the root secret. */
  counter: number;
};

/** The generator ADR 0172 shipped; opened and computed, never offered. */
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
  | DerivedGenerator
  | RulesGenerator
  | PassphraseGenerator
  | SphinxGenerator
  | ManualGenerator;

/**
 * What an older version sealed under a pepper the person typed (ADR 0172): the
 * password, PBKDF2-SHA256 over the pepper, AES-GCM over the secret (v2 wraps a
 * per-password key). Nothing writes one now (ADR 0174); one a vault still holds
 * can be opened once, with the pepper the person chose then, to turn it into an
 * ordinary stored password.
 */
export type PepperSeal = {
  v: 1 | 2;
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
   * *Include pepper.* The password the product produces is incomplete: the
   * person adds a secret of their own, which is not asked for and not stored
   * (ADR 0174). `pepperAt` says where it goes.
   */
  pepper: boolean;
  /**
   * Where the pepper goes in the produced password, as a Python-style index
   * expression (`pepper-position.ts`). Absent or empty: after the last
   * character.
   */
  pepperAt?: string | undefined;
  /**
   * What is kept: the password itself, or for `derived` the root secret the
   * password is computed from. Never a pepper.
   */
  secret: string;
  /**
   * Only on a method an older version sealed under a pepper (`secret` is then
   * empty). It can be opened once and converted; nothing writes it.
   */
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
 * The shape a vault carried before ADR 0172. It is read, never written: a body
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

/** The TOTP seed of the account's first authenticator method, else empty. */
export function accountTotp(item: AccountItem): string {
  return authenticatorMethod(item)?.secret ?? "";
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

/**
 * A new account's password (ADR 0173): derived, under the default rules, with no
 * root yet. The root is minted where a draft is made, never here, so an item
 * built for a test or an import holds no secret it was not given.
 */
export function newPasswordMethod(
  accountId: string,
  createdAt: string,
): PasswordMethod {
  return {
    id: `${accountId}:password`,
    type: "password",
    generator: { id: "derived", rules: { ...DEFAULT_RULES }, counter: 0 },
    pepper: false,
    secret: "",
    changedAt: createdAt,
  };
}

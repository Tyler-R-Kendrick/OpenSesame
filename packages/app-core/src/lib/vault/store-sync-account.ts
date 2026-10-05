/**
 * An account as one sealed-store entry (ADR 0172, ADR 0037 §6). Line one is
 * the first password method's password when nothing has to be asked for it (a
 * pepper, a Sphinx key), as `pass show` reads it; a bare `otpauth://` line is
 * the first authenticator's seed, so `pass otp` works; everything else — every
 * method, the secrets in it included — is the trailer's `values.methods`.
 *
 * An entry written before the account (kind `login`, or no kind at all) reads
 * as the login it was and is normalized to an account on the way in, with the
 * method ids the migration gives it, so the same entry always lands as the
 * same account.
 */
import {
  type JsonObject,
  type JsonValue,
  type MutableJsonObject,
  isJsonObject,
  isString,
  overlapCast,
} from "@opensesame/os-domain";
import {
  type AccountItem,
  type LegacyLoginItem,
  type LoginMethod,
  accountPlainPassword,
  authenticatorMethod,
  createItem,
  migrateLegacyLogin,
  newId,
  passwordMethod,
  plainPassword,
} from "@opensesame/vault-core";
import {
  type OsMeta,
  type StorePlainEntry,
  extractOtpauthFromTrailer,
} from "./store-sync-entry.js";
import { readMethods, writeMethods } from "./store-sync-methods.js";

const OTPAUTH = /^otpauth:\/\//iu;
const ONE_LINE = /^[^\r\n]*$/u;
const REENROLL = ["none", "new-enrolled", "old-retired"] as const;

function textOf(value: JsonValue | undefined): string | undefined {
  return value !== undefined && isString(value) ? value : undefined;
}

function urisOf(meta: OsMeta): AccountItem["uris"] {
  const uris = Array.isArray(meta.uris) ? meta.uris.filter(isString) : [];
  return uris.map((uri, index) => ({
    id: newId(),
    uri,
    match: meta.uriMatches?.[index] ?? "domain",
  }));
}

function valuesOf(meta: OsMeta): JsonObject {
  return isJsonObject(meta.values ?? null) ? overlapCast(meta.values) : {};
}

/** The rotation fields a login and an account share, as a trailer says them. */
function rotationOf(values: JsonObject) {
  const reenroll = REENROLL.find((state) => state === values.reenrollState);
  const retired = values.retiredAt;
  return {
    ...(isString(values.supersededById ?? null)
      ? { supersededById: textOf(values.supersededById) }
      : undefined),
    ...(retired === null || isString(retired ?? null)
      ? { retiredAt: retired === null ? null : textOf(retired) }
      : undefined),
    ...(reenroll === undefined ? undefined : { reenrollState: reenroll }),
  };
}

/** What a first-format or `login` entry said, as the login it described. */
function legacyLoginFromEntry(
  entry: StorePlainEntry,
  meta: OsMeta,
  name: string,
): LegacyLoginItem {
  const {
    methods: _methods,
    kind: _kind,
    ...base
  } = createItem("account", name);
  const values = valuesOf(meta);
  return {
    ...base,
    kind: "login",
    username: textOf(meta.username) ?? "",
    // A line break cannot be line one, so a long password rode in `values`.
    password: textOf(values.password) ?? entry.secret,
    totp: extractOtpauthFromTrailer(entry.trailer) ?? textOf(meta.totp) ?? "",
    uris: urisOf(meta),
    passwordChangedAt: textOf(values.passwordChangedAt) ?? base.createdAt,
    ...(isString(values.resetEmailId ?? null)
      ? { resetEmailId: textOf(values.resetEmailId) }
      : undefined),
    ...rotationOf(values),
    notes: meta.notes ?? "",
  };
}

/** A first password with no pepper takes line one back when its trailer left it out. */
function withLineOne(methods: LoginMethod[], entry: StorePlainEntry) {
  const otpauth = extractOtpauthFromTrailer(entry.trailer);
  const firstPassword = methods.find((m) => m.type === "password");
  const firstSeed = methods.find((m) => m.type === "authenticator");
  return methods.map((method) => {
    if (
      method === firstPassword &&
      method.type === "password" &&
      method.generator.id !== "derived" &&
      method.secret === "" &&
      plainPassword(method) !== null
    ) {
      return { ...method, secret: entry.secret };
    }
    if (
      method === firstSeed &&
      method.type === "authenticator" &&
      method.secret === "" &&
      otpauth !== null
    ) {
      return { ...method, secret: otpauth };
    }
    return method;
  });
}

export function accountFromEntry(
  entry: StorePlainEntry,
  meta: OsMeta,
  name: string,
): AccountItem {
  const values = valuesOf(meta);
  const methods = meta.kind === "account" ? readMethods(values.methods) : null;
  if (methods === null) {
    return migrateLegacyLogin(legacyLoginFromEntry(entry, meta, name));
  }
  const item = createItem("account", name);
  item.username = textOf(meta.username) ?? "";
  item.uris = urisOf(meta);
  item.notes = meta.notes ?? "";
  item.methods = withLineOne(methods, entry);
  if (isString(values.resetEmailId ?? null)) {
    item.resetEmailId = textOf(values.resetEmailId) ?? "";
  }
  Object.assign(item, rotationOf(values));
  return item;
}

/**
 * Put an account's metadata in `meta`; returns the `otpauth://` line, when the
 * first authenticator's seed is one. The password and seed that line one and
 * that line carry are left out of the trailer, which would only repeat them.
 */
export function describeAccount(
  item: AccountItem,
  meta: OsMeta,
): string | null {
  meta.username = item.username || undefined;
  meta.uris = item.uris.map((u) => u.uri).filter(Boolean);
  meta.uriMatches = item.uris.filter((u) => u.uri).map((u) => u.match);
  const first = passwordMethod(item);
  const lineOne = accountPlainPassword(item);
  const blankPassword = lineOne !== "" && ONE_LINE.test(lineOne);
  const seed = authenticatorMethod(item);
  const otpauth =
    seed !== undefined && OTPAUTH.test(seed.secret.trim())
      ? seed.secret.trim()
      : null;
  const methods = item.methods.map((method) => {
    if (blankPassword && method === first && method.type === "password") {
      return { ...method, secret: "" };
    }
    if (
      otpauth !== null &&
      method === seed &&
      method.type === "authenticator"
    ) {
      return { ...method, secret: "" };
    }
    return method;
  });
  const values: MutableJsonObject = {};
  if (item.resetEmailId !== undefined) values.resetEmailId = item.resetEmailId;
  if (item.supersededById !== undefined) {
    values.supersededById = item.supersededById;
  }
  if (item.retiredAt !== undefined) values.retiredAt = item.retiredAt;
  if (item.reenrollState !== undefined) {
    values.reenrollState = item.reenrollState;
  }
  values.methods = writeMethods(methods);
  meta.values = values;
  return otpauth;
}

function sameKind(method: LoginMethod, type: LoginMethod["type"]) {
  return method.type === type;
}

/** The password a first-format entry carried, laid over a method that is typed in the clear. */
function graftSecret(
  current: LoginMethod[],
  incoming: LoginMethod | undefined,
) {
  if (incoming === undefined) return current;
  const type = incoming.type;
  const index = current.findIndex((method) => sameKind(method, type));
  if (index === -1) return [...current, incoming];
  const held = current[index];
  const secret = "secret" in incoming ? incoming.secret : "";
  // A line of text cannot say a pepper, a Sphinx master input or the root a
  // derived password is computed from, so it leaves those methods as they were.
  const askedFor =
    held?.type === "password" &&
    (held.pepper ||
      held.generator.id === "sphinx" ||
      held.generator.id === "derived");
  if (held === undefined || askedFor || !("secret" in held)) return current;
  return current.map((method, i) =>
    i === index ? { ...held, secret } : method,
  );
}

/**
 * A first-format entry said a username, sites, notes, one password and one
 * seed, and nothing else. Laid over an account it changes those, and leaves
 * every other method, the ids of the ones it touched and any password kept
 * behind a pepper, a Sphinx key or a derived root as they were.
 */
export function graftAccountFormatOne(
  current: AccountItem,
  incoming: AccountItem,
): AccountItem {
  let methods = graftSecret(current.methods, passwordMethod(incoming));
  methods = graftSecret(methods, authenticatorMethod(incoming));
  return {
    ...current,
    username: incoming.username,
    uris: incoming.uris,
    notes: incoming.notes,
    methods,
  };
}

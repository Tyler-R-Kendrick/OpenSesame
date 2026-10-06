/**
 * A credential kept on its own as one sealed-store entry (ADR 0179, ADR 0037
 * §6). Line one is the value `pass show` reads: a password kept in the clear,
 * an API key, a token or a client secret. A credential bound to an account is
 * not an entry of its own; it rides in the account's `values.methods`, so a
 * manifest holds each credential once.
 *
 * The method itself is the trailer's `values.method`, read back through the
 * same checks as an account's methods. An entry never says which account it
 * is bound to: a manifest is a file, and binding is made in the vault.
 */
import {
  type JsonObject,
  type JsonValue,
  isJsonObject,
  overlapCast,
} from "@opensesame/os-domain";
import {
  type CredentialItem,
  type LoginMethod,
  createCredential,
  filePassword,
} from "@opensesame/vault-core";
import { withLineOne } from "./store-sync-account.js";
import type { OsMeta, StorePlainEntry } from "./store-sync-entry.js";
import { readMethod } from "./store-sync-methods.js";

const OTPAUTH = /^otpauth:\/\//iu;

/** What `pass show` prints for the credential: the one value, kept in the clear. */
export function credentialLineOne(method: LoginMethod): string {
  switch (method.type) {
    case "password":
      return filePassword(method);
    case "api-key":
      return method.key;
    case "token":
      return method.token;
    case "oauth":
      return method.clientSecret;
    case "authenticator":
      return "";
  }
}

export function credentialFromEntry(
  entry: StorePlainEntry,
  meta: OsMeta,
  name: string,
): CredentialItem | null {
  const values: JsonObject = isJsonObject(meta.values ?? null)
    ? overlapCast(meta.values)
    : {};
  const method = values.method === undefined ? null : readMethod(values.method);
  if (method === null) return null;
  const [filled = method] = withLineOne([method], entry);
  const item = createCredential(withEntryValue(filled, entry), name);
  item.notes = meta.notes ?? "";
  return item;
}

/** A value line one carried back into the method that left it out of the trailer. */
function withEntryValue(method: LoginMethod, entry: StorePlainEntry) {
  if (entry.secret === "") return method;
  switch (method.type) {
    case "api-key":
      return method.key === "" ? { ...method, key: entry.secret } : method;
    case "token":
      return method.token === "" ? { ...method, token: entry.secret } : method;
    case "oauth":
      return method.clientSecret === ""
        ? { ...method, clientSecret: entry.secret }
        : method;
    default:
      return method;
  }
}

/**
 * Put a credential's method in `meta`; returns the `otpauth://` line when an
 * authenticator's seed is one. What line one or that line carries is left out
 * of the trailer, which would only repeat it.
 */
export function describeCredential(
  item: CredentialItem,
  meta: OsMeta,
): string | null {
  const { method } = item;
  const lineOne = credentialLineOne(method);
  const onLineOne = lineOne !== "" && !/[\r\n]/u.test(lineOne);
  const otpauth =
    method.type === "authenticator" && OTPAUTH.test(method.secret.trim())
      ? method.secret.trim()
      : null;
  const written: JsonValue = overlapCast(blanked(method, onLineOne, otpauth));
  meta.values = { method: written };
  return otpauth;
}

function blanked(
  method: LoginMethod,
  onLineOne: boolean,
  otpauth: string | null,
): LoginMethod {
  if (onLineOne) {
    if (method.type === "password") return { ...method, secret: "" };
    if (method.type === "api-key") return { ...method, key: "" };
    if (method.type === "token") return { ...method, token: "" };
    if (method.type === "oauth") return { ...method, clientSecret: "" };
  }
  if (otpauth !== null && method.type === "authenticator") {
    return { ...method, secret: "" };
  }
  return method;
}

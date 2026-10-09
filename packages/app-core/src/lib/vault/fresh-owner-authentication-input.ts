import {
  type BoundaryValue,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
/** Primitive-secret input only. No roots, completed-factor assertions or grants. */
import type { VaultHeader } from "@opensesame/vault-core";
export type FreshOwnerSecrets = Readonly<{
  primary: Readonly<{
    kind: "password" | "pin";
    protectorId: string;
    secret: string;
  }>;
  totpCode?: string;
}>;
export type FreshOwnerAuthentication = string | FreshOwnerSecrets;
export type FreshOwnerSecretDraft = {
  primary: FreshOwnerSecrets["primary"];
  totpCode?: string;
};
const unavailable = () =>
  new Error("Fresh configured authentication input is unavailable.");
/** Bounded record shape, cloned synchronously; current password length follows its existing KDF. */
export function copyFreshOwnerAuthentication(
  input: BoundaryValue,
): FreshOwnerAuthentication {
  if (isString(input)) return input;
  if (
    !isJsonObject(input) ||
    Object.keys(input).some((key) => key !== "primary" && key !== "totpCode")
  )
    throw unavailable();
  const primary = readPrimarySecrets(input.primary);
  const code = input.totpCode;
  if (code !== undefined && (!isString(code) || code.length > 32))
    throw unavailable();
  const result: FreshOwnerSecretDraft = { primary };
  if (code !== undefined) result.totpCode = code;
  return Object.freeze(result);
}

function readPrimarySecrets(
  selected: BoundaryValue,
): FreshOwnerSecrets["primary"] {
  if (
    !isJsonObject(selected) ||
    Object.keys(selected).length !== 3 ||
    Object.keys(selected).some(
      (key) => !["kind", "protectorId", "secret"].includes(key),
    )
  )
    throw unavailable();
  const { kind, protectorId, secret } = selected;
  if (
    (kind !== "password" && kind !== "pin") ||
    !isString(protectorId) ||
    !protectorId.length ||
    protectorId.length > 256 ||
    !isString(secret)
  )
    throw unavailable();
  if (
    kind === "pin" &&
    (secret.normalize("NFKC").length < 8 ||
      secret.normalize("NFKC").length > 12)
  )
    throw unavailable();
  return Object.freeze({ kind, protectorId, secret });
}

/** Only a typed secret request; the issuer still authenticates actual physical records and root. */
export function primarySecretRequest(
  header: VaultHeader | null,
  secret: string,
  kind: "password" | "pin",
): FreshOwnerAuthentication {
  const selected = header?.protection?.records.find(
    (record) => record.kind === kind,
  );
  if (!selected) throw unavailable();
  return Object.freeze({
    primary: Object.freeze({ kind, protectorId: selected.protectorId, secret }),
  });
}

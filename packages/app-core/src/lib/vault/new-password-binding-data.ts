/** Fresh-setup candidate crypto only. Does not identify setup intent or grant REAL. */
import { isJsonObject, overlapCast } from "@opensesame/os-domain";
import {
  type VaultHeader,
  importVaultKey,
  unwrapRawVaultKeyFromPassword,
} from "@opensesame/vault-core";
import { z } from "zod";
import { sessionRootDigestFromKey } from "../duress/store/vault-session-digest.js";
import { verifyHumanVaultData } from "../retired-credentials/human-vault-data.js";
import { verifyHumanVaultProjectionData } from "../retired-credentials/human-vault-projection-data.js";
import { assertUnambiguousJson } from "../retired-credentials/json-preflight.js";
import type { AuthenticationCiphertext } from "./authentication-storage.js";
import type { FreshOwnerAuthentication } from "./fresh-owner-authentication-input.js";
import { readFreshOwnerFactorPolicy } from "./fresh-owner-factor-policy.js";
import {
  prepareNewPrimaryHeaderData,
  readBoundNewPrimaryHeaderData,
} from "./new-primary-header-data.js";
import { unwrapVaultKeyWithPin } from "./unlock-factor-crypto.js";

const BODY_LIMIT = Math.ceil((4 * 1024 * 1024) / 3) * 4 + 128;
const encoded = (length: number) =>
  z
    .string()
    .length(Math.ceil(length / 3) * 4)
    .refine((value) => {
      try {
        return atob(value).length === length && btoa(atob(value)) === value;
      } catch {
        return false;
      }
    });
const wrappedRoot = z.strictObject({ ivB64: encoded(12), ctB64: encoded(48) });
const primaryKdf = z.strictObject({
  alg: z.literal("PBKDF2-SHA256"),
  saltB64: encoded(16),
  iterations: z.number().int().min(600000).max(10000000),
});
const barePasswordHeader = z.strictObject({
  v: z.literal(1),
  createdAt: z.string().max(64).datetime(),
  kdf: primaryKdf,
  wrap: wrappedRoot,
  hint: z.string().max(4096).optional(),
  bodyRev: z.number().int().nonnegative().safe().optional(),
});
const barePinHeader = z.strictObject({
  v: z.literal(1),
  createdAt: z.string().max(64).datetime(),
  unlocks: z.strictObject({
    pin: z.strictObject({
      kdf: primaryKdf,
      wrap: wrappedRoot,
    }),
  }),
  bodyRev: z.number().int().nonnegative().safe().optional(),
});
export type NewPrimaryKind = "password" | "pin";
const sealedBody = z.strictObject({
  ivB64: encoded(12),
  ctB64: z
    .string()
    .min(1)
    .max(BODY_LIMIT - 128),
});
export type PreparedNewPasswordBinding = Readonly<{
  original: AuthenticationCiphertext;
  header: VaultHeader;
  headerText: string;
  rootCommitment: string;
  bodyRevision: number;
  authentication: FreshOwnerAuthentication;
}>;
function unavailable(): never {
  throw new Error("Fresh password setup is unavailable.");
}
type NewPrimaryHeaderData = Readonly<{
  header: VaultHeader;
  body: string;
}>;
function readNewPrimaryHeader(
  snapshot: AuthenticationCiphertext,
  primary: NewPrimaryKind,
  format: "flat-v1" | "node-projection-v1",
): NewPrimaryHeaderData {
  if (format !== "flat-v1" && format !== "node-projection-v1") unavailable();
  if (snapshot.header === null || snapshot.body === null) unavailable();
  assertUnambiguousJson(snapshot.header, 65536);
  assertUnambiguousJson(snapshot.body, BODY_LIMIT);
  const parsed = JSON.parse(snapshot.header);
  const bound = isJsonObject(parsed) && parsed.protection !== undefined;
  const header: VaultHeader = bound
    ? readBoundNewPrimaryHeaderData(snapshot.header, primary)
    : primary === "password"
      ? barePasswordHeader.parse(parsed)
      : barePinHeader.parse(parsed);
  if (bound) {
    const { protection: _proof, ...bare } = header;
    if (primary === "password") barePasswordHeader.parse(bare);
    else barePinHeader.parse(bare);
  }
  const policy = readFreshOwnerFactorPolicy(overlapCast(header));
  if (policy.secondSteps.length || policy.recoveryCodesEnrolled) unavailable();
  return { header, body: snapshot.body };
}
export async function prepareNewPasswordBinding(
  original: AuthenticationCiphertext,
  password: string,
  primary: NewPrimaryKind = "password",
  bodyFormat: "flat-v1" | "node-projection-v1" = "flat-v1",
): Promise<PreparedNewPasswordBinding> {
  const snapshot = Object.freeze({ ...original });
  const format = bodyFormat;
  let root: Uint8Array | undefined;
  try {
    const { header, body } = readNewPrimaryHeader(snapshot, primary, format);
    root =
      primary === "password"
        ? await unwrapRawVaultKeyFromPassword(header, password)
        : await unwrapVaultKeyWithPin(
            header.unlocks?.pin ?? unavailable(),
            password,
          );
    const next = await prepareNewPrimaryHeaderData(header, root);
    const headerText = JSON.stringify(next);
    if (new TextEncoder().encode(headerText).length > 65536) unavailable();
    const data =
      format === "node-projection-v1"
        ? await verifyHumanVaultProjectionData(
            snapshot.tomb,
            headerText,
            body,
            root,
          )
        : await verifyHumanVaultData(
            snapshot.tomb,
            headerText,
            sealedBody.parse(JSON.parse(body)),
            root,
          );
    const key = await importVaultKey(root);
    const rootCommitment = await sessionRootDigestFromKey(key, false);
    if (rootCommitment === null) unavailable();
    const selectedRecord = next.protection?.records.find(
      (record) => record.kind === primary,
    );
    if (!selectedRecord) unavailable();
    const authentication: FreshOwnerAuthentication =
      primary === "password"
        ? password
        : Object.freeze({
            primary: Object.freeze({
              kind: "pin" as const,
              protectorId: selectedRecord.protectorId,
              secret: password,
            }),
          });
    return Object.freeze({
      authentication,
      original: snapshot,
      header: next,
      headerText,
      rootCommitment,
      bodyRevision: data.bodyRevision,
    });
  } catch {
    return unavailable();
  } finally {
    root?.fill(0);
  }
}
export const newPasswordBindingDataMethods = Object.freeze({
  prepare: prepareNewPasswordBinding,
});

import type { BoundaryValue } from "@opensesame/os-domain";
import { b64urlToBytes, bytesToB64url } from "@opensesame/vault-core/bytes.js";
import { z } from "zod";
import { lastProtonMessage, readProtonFields } from "./proton-pass-wire.js";
import {
  type SecretBackendConfiguration,
  SecretBackendError,
} from "./types.js";

export type ProtonPassConfiguration = Pick<
  SecretBackendConfiguration,
  "baseUrl" | "token" | "vaultId"
> & { appVersion: string };
const Text = z.string().min(1).max(4096);
const Header = z
  .string()
  .min(1)
  .max(16384)
  .regex(/^[\x21-\x7e]+$/);
const Rotation = z.number().int().min(0).max(255);
const Expiration = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER / 1000);
const SessionReply = z.object({
  Code: z.literal(1000),
  Session: z.object({
    SessionUID: Header.max(256),
    AccessToken: Header,
    RefreshToken: Header,
    Scopes: z.array(Text.max(128)).max(64),
    AccessExpirationTime: Expiration.nullish(),
    RefreshExpirationTime: Expiration.nullish(),
  }),
});
const Share = z.object({
  ShareID: Text,
  VaultID: Text,
  TargetID: Text,
  TargetType: z.number().int(),
  ShareRoleID: Text.max(128),
  Permission: z.number().int().min(0).max(65535),
  Content: z
    .string()
    .max(2 * 1024 * 1024)
    .nullable(),
  ContentKeyRotation: Rotation.nullable(),
  ContentFormatVersion: z.number().int().nullable(),
  GroupID: Text.nullish(),
});
const SharesReply = z.object({
  Code: z.literal(1000),
  Shares: z.array(Share).max(1000),
});
const KeysReply = z.object({
  Code: z.literal(1000),
  ShareKeys: z.object({
    Total: z.number().int().min(1).max(256),
    Keys: z
      .array(
        z.object({
          KeyRotation: Rotation,
          Key: Text,
          CreateTime: z.number().int(),
        }),
      )
      .max(100),
  }),
});
export type ProtonShare = Readonly<{
  id: string;
  vaultId: string;
  content: string;
  rotation: number;
  writable: boolean;
}>;

function invalid(): SecretBackendError {
  return new SecretBackendError(
    "response",
    "Proton Pass returned invalid session or vault metadata.",
  );
}
export function protonConfiguration(
  config: Omit<ProtonPassConfiguration, "token">,
): void {
  if (
    !config.vaultId ||
    [".", ".."].includes(config.vaultId) ||
    config.vaultId.length > 4096 ||
    config.appVersion.length > 128 ||
    !/^[a-z0-9]+-[a-z0-9-]+@[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}$/.test(
      config.appVersion,
    )
  )
    throw new SecretBackendError(
      "configuration",
      "Enter the PAT-scoped Share ID and accepted application/version header.",
    );
}
export function splitProtonPat(value: string) {
  const parts = value.trim().split("::");
  const token = parts[0] ?? "";
  const key = parts[1] ?? "";
  if (
    parts.length !== 2 ||
    token.length !== 68 ||
    !token.startsWith("pst_") ||
    !/^[\x21-\x7e]+$/.test(token) ||
    !/^[A-Za-z0-9_-]{43}$/.test(key)
  )
    throw new SecretBackendError(
      "configuration",
      "Enter the complete scoped Proton Pass personal access token.",
    );
  const raw = b64urlToBytes(key);
  if (raw.length !== 32 || bytesToB64url(raw) !== key) {
    raw.fill(0);
    throw new SecretBackendError(
      "configuration",
      "The personal access token key is invalid.",
    );
  }
  return { token, raw };
}
export function protonSessionReply(reply: BoundaryValue, started: number) {
  const parsed = SessionReply.safeParse(reply);
  if (!parsed.success) throw invalid();
  const session = parsed.data.Session;
  const deadline = Math.min(
    started + 2 * 60 * 60 * 1000,
    ...[session.AccessExpirationTime, session.RefreshExpirationTime]
      .filter((value) => value !== null && value !== undefined)
      .map((value) => value * 1000),
  );
  if (deadline <= Date.now()) throw invalid();
  return { uid: session.SessionUID, token: session.AccessToken, deadline };
}
export function protonShare(reply: BoundaryValue, id: string): ProtonShare {
  const parsed = SharesReply.safeParse(reply);
  if (!parsed.success) throw invalid();
  const matches = parsed.data.Shares.filter((share) => share.ShareID === id);
  const selected = matches[0];
  if (matches.length !== 1 || !selected) throw invalid();
  if (
    selected.TargetType !== 1 ||
    selected.TargetID !== selected.VaultID ||
    selected.GroupID ||
    selected.ContentFormatVersion !== 1 ||
    !selected.Content ||
    selected.ContentKeyRotation === null
  )
    throw new SecretBackendError(
      "unsupported",
      "Select a whole-vault PAT share with encrypted vault metadata.",
    );
  const permissions = new Map<string, number>([
    ["1", 1],
    ["2", 62],
    ["3", 2],
  ]);
  const permission =
    permissions.get(selected.ShareRoleID) ?? selected.Permission;
  if (!(permission & 1) && !(permission & 2)) throw invalid();
  return Object.freeze({
    id,
    vaultId: selected.VaultID,
    content: selected.Content,
    rotation: selected.ContentKeyRotation,
    writable: Boolean(permission & 1 || (permission & 30) === 30),
  });
}
export function protonKeys(reply: BoundaryValue) {
  const parsed = KeysReply.safeParse(reply);
  if (!parsed.success) throw invalid();
  return parsed.data.ShareKeys;
}
export function protonVaultName(bytes: Uint8Array): string {
  try {
    const value = lastProtonMessage(readProtonFields(bytes), 1);
    if (!value) throw invalid();
    const name = new TextDecoder("utf-8", { fatal: true }).decode(value);
    if (!name || name.length > 4096) throw invalid();
    return name;
  } catch {
    throw invalid();
  }
}

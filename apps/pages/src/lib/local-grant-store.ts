import {
  type BoundaryValue,
  isJsonObject,
  isNumber,
  isString,
} from "@opensesame/os-domain";
import { kvRefresh } from "./kv.js";
import { LocalDirectoryError } from "./local-directory.js";
import { notifyLocalIamChange } from "./local-iam-events.js";
import { VfsError, readFile, tombFileKey, writeFile } from "./vfs.js";

const PATH = "config/identity-grants";
const MAX_BYTES = 1_000_000;
const GRANT_FIELDS = new Set([
  "id",
  "principalId",
  "sessionId",
  "applicationId",
  "organizationId",
  "applicationRevision",
  "redirectUri",
  "scopes",
  "nonce",
  "issuedAt",
  "expiresAt",
  "approval",
]);
export type LocalGrantRecord = {
  id: string;
  principalId: string;
  sessionId: string;
  applicationId: string;
  organizationId: string;
  applicationRevision: number;
  redirectUri: string;
  scopes: string[];
  nonce: string;
  issuedAt: number;
  expiresAt: number;
  approval?: { principalId: string; sessionId: string };
};
function text(value: BoundaryValue, max: number): value is string {
  return isString(value) && value.length > 0 && value.length <= max;
}
function timestamp(value: BoundaryValue): value is number {
  return isNumber(value) && Number.isSafeInteger(value) && value >= 0;
}
function validScopes(value: BoundaryValue): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= 32 &&
    value.every(
      (scope) => text(scope, 64) && /^[A-Za-z0-9][A-Za-z0-9:._-]*$/.test(scope),
    ) &&
    value.includes("openid") &&
    new Set(value).size === value.length
  );
}
function validMetadata(value: BoundaryValue): boolean {
  return (
    isJsonObject(value) &&
    Object.keys(value).every((key) => GRANT_FIELDS.has(key)) &&
    validApproval(value.approval) &&
    timestamp(value.issuedAt) &&
    timestamp(value.expiresAt) &&
    value.expiresAt > value.issuedAt &&
    value.expiresAt - value.issuedAt <= 15 * 60_000
  );
}
function validApproval(value: BoundaryValue): boolean {
  return (
    value === undefined ||
    (isJsonObject(value) &&
      Object.keys(value).length === 2 &&
      text(value.principalId, 42) &&
      text(value.sessionId, 36))
  );
}
function isGrant(value: BoundaryValue): value is LocalGrantRecord {
  return (
    isJsonObject(value) &&
    text(value.id, 36) &&
    text(value.sessionId, 36) &&
    text(value.principalId, 42) &&
    text(value.applicationId, 42) &&
    text(value.organizationId, 42) &&
    timestamp(value.applicationRevision) &&
    value.applicationRevision > 0 &&
    text(value.redirectUri, 2048) &&
    validScopes(value.scopes) &&
    text(value.nonce, 128) &&
    /^[A-Za-z0-9_-]{22,128}$/.test(value.nonce) &&
    validMetadata(value)
  );
}

/** Internal encrypted ledger. Callers hold the directory/session fence. */
export async function readLocalGrantRecords(
  tomb: string,
): Promise<LocalGrantRecord[]> {
  await kvRefresh(tombFileKey(tomb, PATH), MAX_BYTES * 2);
  try {
    const bytes = await readFile(tomb, PATH);
    if (bytes.length > MAX_BYTES)
      throw new LocalDirectoryError("Local grant storage exceeds its limit.");
    const value: BoundaryValue = JSON.parse(new TextDecoder().decode(bytes));
    if (
      !isJsonObject(value) ||
      (value.version !== 1 && value.version !== 2) ||
      !Array.isArray(value.grants) ||
      value.grants.length > 512 ||
      !value.grants.every(isGrant) ||
      (value.version === 1 &&
        value.grants.some((row) => row.approval !== undefined)) ||
      new Set(value.grants.map((row) => row.id)).size !== value.grants.length
    )
      throw new LocalDirectoryError(
        "Local grant storage is invalid. Restore a valid vault backup.",
      );
    return value.grants;
  } catch (error) {
    if (error instanceof VfsError && error.code === "not-found") return [];
    throw error;
  }
}

/** Internal commit: one fenced encrypted write, never a browser/agent RPC. */
export async function writeLocalGrantRecords(
  tomb: string,
  grants: LocalGrantRecord[],
): Promise<void> {
  if (
    grants.length > 512 ||
    !grants.every(isGrant) ||
    new Set(grants.map((row) => row.id)).size !== grants.length
  )
    throw new LocalDirectoryError("Local grant capacity or validation failed.");
  const bytes = new TextEncoder().encode(
    JSON.stringify({ version: 2, grants }),
  );
  if (bytes.length > MAX_BYTES)
    throw new LocalDirectoryError("Local grant storage exceeds its limit.");
  try {
    await writeFile(tomb, PATH, bytes);
  } finally {
    notifyLocalIamChange();
  }
}

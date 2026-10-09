/**
 * Sealed on-disk share ledger for `local-share-grants.ts`.
 */

import {
  type BoundaryValue,
  isJsonObject,
  isNumber,
  isString,
} from "@opensesame/os-domain";
import { kvRefresh } from "./kv.js";
import { LocalDirectoryError } from "./local-directory.js";
import { notifyLocalIamChange } from "./local-iam-events.js";
import {
  type LocalShare,
  SHARE_POLICIES,
  type ShareKind,
} from "./local-share-grants-types.js";
import { VfsError, readFile, tombFileKey, writeFile } from "./vfs.js";

export const SHARE_STORAGE_PATH = "config/identity-shares";
const MAX_BYTES = 256_000;
const MAX_SHARES = 256;

function text(value: BoundaryValue, max: number): value is string {
  return isString(value) && value.length > 0 && value.length <= max;
}

function isKind(value: BoundaryValue): value is ShareKind {
  return value === "vault" || value === "connection" || value === "item";
}

function allowedPolicy(kind: ShareKind, policy: string): boolean {
  return SHARE_POLICIES[kind].some((entry) => entry.id === policy);
}

function isShare(value: BoundaryValue): value is LocalShare {
  return (
    isJsonObject(value) &&
    text(value.id, 36) &&
    text(value.principalId, 64) &&
    isKind(value.resourceKind) &&
    text(value.resourceId, 128) &&
    text(value.resourceLabel, 128) &&
    text(value.policy, 32) &&
    allowedPolicy(value.resourceKind, value.policy) &&
    (value.sessionId === undefined || text(value.sessionId, 36)) &&
    isNumber(value.issuedAt) &&
    isNumber(value.expiresAt) &&
    Number.isSafeInteger(value.issuedAt) &&
    Number.isSafeInteger(value.expiresAt) &&
    value.expiresAt > value.issuedAt
  );
}

export async function readAllShares(tomb: string): Promise<LocalShare[]> {
  await kvRefresh(tombFileKey(tomb, SHARE_STORAGE_PATH), MAX_BYTES * 2);
  try {
    const bytes = await readFile(tomb, SHARE_STORAGE_PATH);
    if (bytes.length > MAX_BYTES)
      throw new LocalDirectoryError("Share storage exceeds its limit.");
    const value: BoundaryValue = JSON.parse(new TextDecoder().decode(bytes));
    if (
      !isJsonObject(value) ||
      value.version !== 1 ||
      !Array.isArray(value.shares) ||
      value.shares.length > MAX_SHARES ||
      !value.shares.every(isShare)
    )
      throw new LocalDirectoryError("Share storage is invalid.");
    return value.shares;
  } catch (error) {
    if (error instanceof VfsError && error.code === "not-found") return [];
    throw error;
  }
}

export async function writeAllShares(
  tomb: string,
  shares: LocalShare[],
): Promise<void> {
  const bytes = new TextEncoder().encode(
    JSON.stringify({ version: 1, shares }),
  );
  if (bytes.length > MAX_BYTES)
    throw new LocalDirectoryError("Share storage exceeds its limit.");
  try {
    await writeFile(tomb, SHARE_STORAGE_PATH, bytes);
  } finally {
    notifyLocalIamChange();
  }
}

export function shareTextField(
  value: BoundaryValue,
  max: number,
): value is string {
  return text(value, max);
}

export function shareKindValue(value: BoundaryValue): value is ShareKind {
  return isKind(value);
}

export function sharePolicyAllowed(kind: ShareKind, policy: string): boolean {
  return allowedPolicy(kind, policy);
}

export const SHARE_CAPACITY = MAX_SHARES;

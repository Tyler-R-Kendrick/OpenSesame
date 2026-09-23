/**
 * Sealed Vercel Connect session for Pages (ADR 0090 / ADR 0115).
 * The bearer stays in the tomb (or in memory until the first unlock seals it).
 * Never compiled into the static bundle.
 */

import {
  type BoundaryValue,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import {
  type VercelConnectAuth,
  setVercelConnectAuth,
} from "./vercel-connect.js";
import { VfsError, deleteFile, readFile, writeFile } from "./vfs.js";

export const CONNECT_AUTH_PATH = "config/vercel-connect-auth";
const MAX_BYTES = 4_096;

type SealedConnectAuth = {
  version: 1;
  token: string;
  teamId?: string;
  projectId?: string;
};

let pending: VercelConnectAuth | null = null;

function text(value: BoundaryValue | undefined, max = 512): string {
  return isString(value) ? value.trim().slice(0, max) : "";
}

function parseRecord(value: BoundaryValue): SealedConnectAuth | null {
  if (!isJsonObject(value) || value.version !== 1) return null;
  const token = text(value.token, 512);
  if (!token) return null;
  const teamId = text(value.teamId, 128);
  const projectId = text(value.projectId, 128);
  const record: SealedConnectAuth = { version: 1, token };
  if (teamId) record.teamId = teamId;
  if (projectId) record.projectId = projectId;
  return record;
}

function toAuth(record: SealedConnectAuth): VercelConnectAuth {
  const auth: VercelConnectAuth = { token: record.token };
  if (record.teamId) auth.teamId = record.teamId;
  if (record.projectId) auth.projectId = record.projectId;
  return auth;
}

export function pendingVercelConnectAuth(): VercelConnectAuth | null {
  return pending;
}

export function clearPendingVercelConnectAuth(): void {
  pending = null;
}

/** Forget the live Connect transport (lock / sign-out). */
export function disarmVercelConnectAuth(): void {
  setVercelConnectAuth(null);
}

export async function readVercelConnectAuth(
  tomb: string,
): Promise<VercelConnectAuth | null> {
  try {
    const bytes = await readFile(tomb, CONNECT_AUTH_PATH);
    if (bytes.length > MAX_BYTES) return null;
    const parsed: BoundaryValue = JSON.parse(new TextDecoder().decode(bytes));
    const record = parseRecord(parsed);
    return record ? toAuth(record) : null;
  } catch (error) {
    if (error instanceof VfsError && error.code === "not-found") return null;
    throw error;
  }
}

export async function writeVercelConnectAuth(
  tomb: string,
  auth: VercelConnectAuth,
): Promise<void> {
  const token = auth.token.trim();
  if (!token) throw new Error("A Vercel token is required.");
  const record: SealedConnectAuth = { version: 1, token };
  if (auth.teamId?.trim()) record.teamId = auth.teamId.trim();
  if (auth.projectId?.trim()) record.projectId = auth.projectId.trim();
  const bytes = new TextEncoder().encode(JSON.stringify(record));
  if (bytes.length > MAX_BYTES) {
    throw new Error("That Connect session is too large to keep here.");
  }
  await writeFile(tomb, CONNECT_AUTH_PATH, bytes);
}

export async function forgetVercelConnectAuth(
  tomb: string | null,
): Promise<void> {
  pending = null;
  setVercelConnectAuth(null);
  if (!tomb) return;
  try {
    await deleteFile(tomb, CONNECT_AUTH_PATH);
  } catch (error) {
    if (error instanceof VfsError && error.code === "not-found") return;
    throw error;
  }
}

/**
 * Arm Connect for this session. With an open tomb, seal it; otherwise hold
 * the credential in memory until unlock can write the sealed record.
 */
type VercelConnectAuthOpts = {
  ephemeral?: boolean;
};

export async function armVercelConnectAuth(
  auth: VercelConnectAuth,
  tomb: string | null,
  opts: VercelConnectAuthOpts = {},
): Promise<void> {
  const next: VercelConnectAuth = { token: auth.token.trim() };
  if (auth.teamId?.trim()) next.teamId = auth.teamId.trim();
  if (auth.projectId?.trim()) next.projectId = auth.projectId.trim();
  if (!next.token) throw new Error("A Vercel token is required.");
  setVercelConnectAuth(next);
  if (tomb && !opts.ephemeral) {
    pending = null;
    await writeVercelConnectAuth(tomb, next);
    return;
  }
  pending = next;
}

/** Unlock path: seal any staged credential, then hydrate from the tomb. */
export async function hydrateVercelConnectAuth(
  tomb: string,
  opts: VercelConnectAuthOpts = {},
): Promise<boolean> {
  if (pending && !opts.ephemeral) {
    await writeVercelConnectAuth(tomb, pending);
    pending = null;
  } else if (pending && opts.ephemeral) {
    setVercelConnectAuth(pending);
    return true;
  }
  const sealed = await readVercelConnectAuth(tomb);
  if (!sealed) {
    if (!pending) setVercelConnectAuth(null);
    return false;
  }
  setVercelConnectAuth(sealed);
  return true;
}

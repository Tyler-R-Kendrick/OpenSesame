/**
 * Vault-bound Access sessions — time-boxed grants with a join code.
 *
 * A session is stored in the unlocked vault, bound to that tomb/project. While
 * running it issues LocalShares for the configured subjects (identity, Access
 * role, or org role) and optional row (item) targets. Stopping revokes those
 * shares; restarting reissues them for a fresh TTL. The session code is what
 * Join a session / redeem uses to attach a principal mid-run.
 */

import type { OrganizationRole } from "@opensesame/os-domain";
import {
  type BoundaryValue,
  isJsonObject,
  isNumber,
  isString,
} from "@opensesame/os-domain";
import { kvRefresh } from "./kv.js";
import { LocalDirectoryError } from "./local-directory.js";
import { notifyLocalIamChange } from "./local-iam-events.js";
import type { AccessRole } from "./local-rbac.js";
import { assertAccessCapability } from "./local-rbac.js";
import {
  type ShareKind,
  revokeSharesForSession,
} from "./local-share-grants.js";
import { issueSessionGrants } from "./local-vault-session-issue.js";
import { VfsError, readFile, tombFileKey, writeFile } from "./vfs.js";

const PATH = "config/vault-sessions";
const MAX_BYTES = 256_000;
const MAX_SESSIONS = 64;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export type SessionSubject =
  | { kind: "principal"; principalId: string }
  | { kind: "accessRole"; role: AccessRole }
  | { kind: "orgRole"; role: OrganizationRole };

export type SessionGrantSpec = {
  subject: SessionSubject;
  resourceKind: ShareKind;
  resourceId: string;
  resourceLabel: string;
  policy: string;
};

export type LocalVaultSession = {
  id: string;
  code: string;
  label: string;
  status: "running" | "stopped";
  durationSeconds: number;
  startedAt: number | null;
  expiresAt: number | null;
  boundTomb: string;
  grants: SessionGrantSpec[];
  issuedShareIds: string[];
};

export type CreateVaultSessionInput = {
  label: string;
  durationSeconds: number;
  grants: SessionGrantSpec[];
  start?: boolean;
};

function text(value: BoundaryValue, max: number): value is string {
  return isString(value) && value.length > 0 && value.length <= max;
}

function mintCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return [...bytes]
    .map((byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length])
    .join("");
}

function isSubject(value: BoundaryValue): value is SessionSubject {
  if (!isJsonObject(value) || !isString(value.kind)) return false;
  if (value.kind === "principal") return text(value.principalId, 42);
  if (value.kind === "accessRole")
    return (
      value.role === "operator" ||
      value.role === "member" ||
      value.role === "guest"
    );
  if (value.kind === "orgRole")
    return (
      value.role === "owner" ||
      value.role === "admin" ||
      value.role === "member"
    );
  return false;
}

function isGrantSpec(value: BoundaryValue): value is SessionGrantSpec {
  return (
    isJsonObject(value) &&
    isSubject(value.subject) &&
    (value.resourceKind === "vault" ||
      value.resourceKind === "connection" ||
      value.resourceKind === "item") &&
    text(value.resourceId, 128) &&
    text(value.resourceLabel, 128) &&
    text(value.policy, 32)
  );
}

function isSession(value: BoundaryValue): value is LocalVaultSession {
  return (
    isJsonObject(value) &&
    text(value.id, 36) &&
    text(value.code, 12) &&
    text(value.label, 128) &&
    (value.status === "running" || value.status === "stopped") &&
    isNumber(value.durationSeconds) &&
    Number.isSafeInteger(value.durationSeconds) &&
    value.durationSeconds >= 60 &&
    value.durationSeconds <= 7 * 86400 &&
    (value.startedAt === null ||
      (isNumber(value.startedAt) && Number.isSafeInteger(value.startedAt))) &&
    (value.expiresAt === null ||
      (isNumber(value.expiresAt) && Number.isSafeInteger(value.expiresAt))) &&
    text(value.boundTomb, 128) &&
    Array.isArray(value.grants) &&
    value.grants.length <= 64 &&
    value.grants.every(isGrantSpec) &&
    Array.isArray(value.issuedShareIds) &&
    value.issuedShareIds.every((id) => text(id, 36))
  );
}

async function readAll(tomb: string): Promise<LocalVaultSession[]> {
  await kvRefresh(tombFileKey(tomb, PATH), MAX_BYTES * 2);
  try {
    const bytes = await readFile(tomb, PATH);
    if (bytes.length > MAX_BYTES)
      throw new LocalDirectoryError("Session storage exceeds its limit.");
    const value: BoundaryValue = JSON.parse(new TextDecoder().decode(bytes));
    if (
      !isJsonObject(value) ||
      value.version !== 1 ||
      !Array.isArray(value.sessions) ||
      value.sessions.length > MAX_SESSIONS ||
      !value.sessions.every(isSession)
    )
      throw new LocalDirectoryError("Session storage is invalid.");
    return value.sessions;
  } catch (error) {
    if (error instanceof VfsError && error.code === "not-found") return [];
    throw error;
  }
}

async function writeAll(
  tomb: string,
  sessions: LocalVaultSession[],
): Promise<void> {
  const bytes = new TextEncoder().encode(
    JSON.stringify({ version: 1, sessions }),
  );
  if (bytes.length > MAX_BYTES)
    throw new LocalDirectoryError("Session storage exceeds its limit.");
  try {
    await writeFile(tomb, PATH, bytes);
  } finally {
    notifyLocalIamChange();
  }
}

function isExpired(session: LocalVaultSession): boolean {
  return (
    session.status === "running" &&
    session.expiresAt !== null &&
    session.expiresAt <= Date.now()
  );
}

async function settleExpired(
  tomb: string,
  sessions: LocalVaultSession[],
): Promise<LocalVaultSession[]> {
  let dirty = false;
  const next: LocalVaultSession[] = [];
  for (const session of sessions) {
    if (!isExpired(session)) {
      next.push(session);
      continue;
    }
    dirty = true;
    await revokeSharesForSession(tomb, session.id, {
      bypassAccessCheck: true,
    });
    next.push({
      ...session,
      status: "stopped",
      startedAt: null,
      expiresAt: null,
      issuedShareIds: [],
    });
  }
  if (dirty) await writeAll(tomb, next);
  return next;
}

export async function listVaultSessions(
  tomb: string,
): Promise<LocalVaultSession[]> {
  return settleExpired(tomb, await readAll(tomb));
}

export async function createVaultSession(
  tomb: string,
  input: CreateVaultSessionInput,
): Promise<LocalVaultSession> {
  await assertAccessCapability(tomb, "manage_grants");
  const label = input.label.trim();
  if (!label || label.length > 128)
    throw new LocalDirectoryError("Name this session in 1–128 characters.");
  if (
    !Number.isSafeInteger(input.durationSeconds) ||
    input.durationSeconds < 60 ||
    input.durationSeconds > 7 * 86400
  )
    throw new LocalDirectoryError(
      "Choose a session lifetime between one minute and one week.",
    );
  if (input.grants.length < 1 || input.grants.length > 64)
    throw new LocalDirectoryError("Add at least one grant to the session.");
  const current = await readAll(tomb);
  if (current.length >= MAX_SESSIONS)
    throw new LocalDirectoryError("Session capacity is full.");
  let session: LocalVaultSession = {
    id: crypto.randomUUID(),
    code: mintCode(),
    label,
    status: "stopped",
    durationSeconds: input.durationSeconds,
    startedAt: null,
    expiresAt: null,
    boundTomb: tomb,
    grants: input.grants,
    issuedShareIds: [],
  };
  current.push(session);
  await writeAll(tomb, current);
  if (input.start) session = await startVaultSession(tomb, session.id);
  return session;
}

export async function startVaultSession(
  tomb: string,
  sessionId: string,
): Promise<LocalVaultSession> {
  await assertAccessCapability(tomb, "manage_grants");
  const current = await settleExpired(tomb, await readAll(tomb));
  const index = current.findIndex((row) => row.id === sessionId);
  if (index < 0) throw new LocalDirectoryError("This session is unavailable.");
  let session = current[index];
  if (!session) throw new LocalDirectoryError("This session is unavailable.");
  if (session.status === "running") {
    await revokeSharesForSession(tomb, session.id, { bypassAccessCheck: true });
  }
  const startedAt = Date.now();
  session = {
    ...session,
    status: "running",
    startedAt,
    expiresAt: startedAt + session.durationSeconds * 1000,
    issuedShareIds: [],
  };
  const issued = await issueSessionGrants(tomb, session);
  session = { ...session, issuedShareIds: issued };
  current[index] = session;
  await writeAll(tomb, current);
  return session;
}

export async function stopVaultSession(
  tomb: string,
  sessionId: string,
): Promise<LocalVaultSession> {
  await assertAccessCapability(tomb, "manage_grants");
  const current = await readAll(tomb);
  const index = current.findIndex((row) => row.id === sessionId);
  if (index < 0) throw new LocalDirectoryError("This session is unavailable.");
  const session = current[index];
  if (!session) throw new LocalDirectoryError("This session is unavailable.");
  await revokeSharesForSession(tomb, session.id, { bypassAccessCheck: true });
  const stopped: LocalVaultSession = {
    ...session,
    status: "stopped",
    startedAt: null,
    expiresAt: null,
    issuedShareIds: [],
  };
  current[index] = stopped;
  await writeAll(tomb, current);
  return stopped;
}

export async function restartVaultSession(
  tomb: string,
  sessionId: string,
): Promise<LocalVaultSession> {
  await stopVaultSession(tomb, sessionId);
  return startVaultSession(tomb, sessionId);
}

/** Redeem a running session code for the given principal — join mid-run. */
export async function redeemVaultSessionCode(
  tomb: string,
  code: string,
  principalId: string,
): Promise<LocalVaultSession> {
  const normalized = code.trim().toUpperCase();
  if (!normalized)
    throw new LocalDirectoryError("Enter the session code to join.");
  const current = await settleExpired(tomb, await readAll(tomb));
  const index = current.findIndex((row) => row.code === normalized);
  if (index < 0)
    throw new LocalDirectoryError(
      "That session code is unknown, stopped, or expired.",
    );
  let session = current[index];
  if (!session || session.status !== "running")
    throw new LocalDirectoryError(
      "That session code is unknown, stopped, or expired.",
    );
  const issued = await issueSessionGrants(tomb, session, principalId);
  session = {
    ...session,
    issuedShareIds: [...session.issuedShareIds, ...issued],
  };
  current[index] = session;
  await writeAll(tomb, current);
  return session;
}

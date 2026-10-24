/**
 * Vault-bound Access sessions — time-boxed grants with a join code.
 *
 * A session is stored in the unlocked vault, bound to that tomb/project. While
 * running it issues LocalShares for the configured subjects (identity, Access
 * role, or org role) and optional row (item) targets. Stopping revokes those
 * shares; restarting reissues them for a fresh TTL. The session code is what
 * Join a session / redeem uses to attach a principal mid-run.
 */

import { type Named, name } from "@gdp-ts/core";
import { type BoundaryValue, isJsonObject } from "@opensesame/os-domain";
import { kvRefresh } from "./kv.js";
import { withLocalAccessLedgerLock } from "./local-access-ledger-lock.js";
import { LocalDirectoryError } from "./local-directory.js";
import { notifyLocalIamChange } from "./local-iam-events.js";
import { assertAccessCapability } from "./local-rbac.js";
import { revokeSharesForSession } from "./local-share-grants.js";
import { mintSessionCode } from "./local-vault-session-code.js";
import { issueSessionGrants } from "./local-vault-session-issue.js";
import { isGrantSpec, isSession } from "./local-vault-session-shape.js";
import type {
  CreateVaultSessionInput,
  LocalVaultSession,
  SessionGrantSpec,
} from "./local-vault-session-types.js";
import {
  type ManageGrants,
  requireManageGrants,
  systemShareWrite,
} from "./proofs/share-write.js";
import { VfsError, readFile, tombFileKey, writeFile } from "./vfs.js";

export type {
  CreateVaultSessionInput,
  LocalVaultSession,
  SessionGrantSpec,
  SessionSubject,
} from "./local-vault-session-types.js";

const PATH = "config/vault-sessions";
const MAX_BYTES = 256_000;
const MAX_SESSIONS = 64;

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
    const sessions = value.sessions;
    if (
      sessions.some((session) => session.boundTomb !== tomb) ||
      new Set(sessions.map((session) => session.id)).size !== sessions.length ||
      new Set(sessions.map((session) => session.code)).size !== sessions.length
    )
      throw new LocalDirectoryError("Session storage is invalid.");
    return sessions;
  } catch (error) {
    if (error instanceof VfsError && error.code === "not-found") return [];
    throw error;
  }
}

async function writeAll(
  tomb: string,
  sessions: LocalVaultSession[],
): Promise<void> {
  if (sessions.length > MAX_SESSIONS || !sessions.every(isSession))
    throw new LocalDirectoryError("Session storage is invalid.");
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
    // An expiry sweep runs for the vault, whoever opened the list.
    await name(tomb, (named) =>
      revokeSharesForSession(named, session.id, systemShareWrite(named)),
    );
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

async function readSettledSessions(tomb: string): Promise<LocalVaultSession[]> {
  return withLocalAccessLedgerLock(tomb, "session", PATH, MAX_BYTES, async () =>
    settleExpired(tomb, await readAll(tomb)),
  );
}

/** Records include join codes and grants: only grant administrators may list them. */
export async function listVaultSessions(
  tomb: string,
): Promise<LocalVaultSession[]> {
  await assertAccessCapability(tomb, "manage_grants");
  return readSettledSessions(tomb);
}

/**
 * The resource ids a session currently grants, without its bearer code or
 * labels. Travel's copy detector needs only this much; members must not be
 * able to read join credentials through it.
 */
export async function listVaultSessionGrantResources(
  tomb: string,
): Promise<
  ReadonlyArray<Pick<SessionGrantSpec, "resourceKind" | "resourceId">>
> {
  const sessions = await readSettledSessions(tomb);
  return sessions.flatMap((session) =>
    session.grants.map((grant) => ({
      resourceKind: grant.resourceKind,
      resourceId: grant.resourceId,
    })),
  );
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
  if (
    !Array.isArray(input.grants) ||
    input.grants.length < 1 ||
    input.grants.length > 64 ||
    !input.grants.every(isGrantSpec)
  )
    throw new LocalDirectoryError(
      "Add at least one valid grant to the session.",
    );
  let session = await withLocalAccessLedgerLock(
    tomb,
    "session",
    PATH,
    MAX_BYTES,
    async () => {
      const current = await readAll(tomb);
      if (current.length >= MAX_SESSIONS)
        throw new LocalDirectoryError("Session capacity is full.");
      let code = mintSessionCode();
      while (current.some((row) => row.code === code)) code = mintSessionCode();
      const created: LocalVaultSession = {
        id: crypto.randomUUID(),
        code,
        label,
        status: "stopped",
        durationSeconds: input.durationSeconds,
        startedAt: null,
        expiresAt: null,
        boundTomb: tomb,
        grants: input.grants,
        issuedShareIds: [],
      };
      current.push(created);
      await writeAll(tomb, current);
      return created;
    },
  );
  if (input.start) session = await startVaultSession(tomb, session.id);
  return session;
}

export async function startVaultSession(
  tomb: string,
  sessionId: string,
): Promise<LocalVaultSession> {
  return withLocalAccessLedgerLock(tomb, "session", PATH, MAX_BYTES, () =>
    name(tomb, async (named) => {
      const manage = await requireManageGrants(named);
      return startCheckedVaultSession(named, tomb, sessionId, manage);
    }),
  );
}

async function startCheckedVaultSession<T>(
  named: Named<T, string>,
  tomb: string,
  sessionId: string,
  manage: ManageGrants<T>,
): Promise<LocalVaultSession> {
  const current = await settleExpired(tomb, await readAll(tomb));
  const index = current.findIndex((row) => row.id === sessionId);
  if (index < 0) throw new LocalDirectoryError("This session is unavailable.");
  let session = current[index];
  if (!session) throw new LocalDirectoryError("This session is unavailable.");
  if (session.status === "running") {
    await revokeSharesForSession(named, session.id, manage);
  }
  const startedAt = Date.now();
  session = {
    ...session,
    status: "running",
    startedAt,
    expiresAt: startedAt + session.durationSeconds * 1000,
    issuedShareIds: [],
  };
  try {
    const issued = await issueSessionGrants(tomb, session);
    session = { ...session, issuedShareIds: issued };
    current[index] = session;
    await writeAll(tomb, current);
  } catch (error) {
    await revokeSharesForSession(named, session.id, manage);
    const previous = current[index];
    if (previous?.status === "running") {
      current[index] = {
        ...previous,
        status: "stopped",
        startedAt: null,
        expiresAt: null,
        issuedShareIds: [],
      };
      await writeAll(tomb, current);
    }
    throw error;
  }
  return session;
}

export async function stopVaultSession(
  tomb: string,
  sessionId: string,
): Promise<LocalVaultSession> {
  return withLocalAccessLedgerLock(tomb, "session", PATH, MAX_BYTES, () =>
    name(tomb, async (named) => {
      const manage = await requireManageGrants(named);
      return stopCheckedVaultSession(named, tomb, sessionId, manage);
    }),
  );
}

async function stopCheckedVaultSession<T>(
  named: Named<T, string>,
  tomb: string,
  sessionId: string,
  manage: ManageGrants<T>,
): Promise<LocalVaultSession> {
  const current = await readAll(tomb);
  const index = current.findIndex((row) => row.id === sessionId);
  if (index < 0) throw new LocalDirectoryError("This session is unavailable.");
  const session = current[index];
  if (!session) throw new LocalDirectoryError("This session is unavailable.");
  await revokeSharesForSession(named, session.id, manage);
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
  return withLocalAccessLedgerLock(
    tomb,
    "session",
    PATH,
    MAX_BYTES,
    async () => {
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
    },
  );
}

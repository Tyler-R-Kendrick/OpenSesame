import {
  type BoundaryValue,
  isJsonObject,
  isNumber,
  isString,
} from "@opensesame/os-domain";
import { bytesToB64url, sha256Base64Url } from "@opensesame/sdk-browser";
import { kvRefresh } from "./kv.js";
import { readLocalAgentKeys } from "./local-agent-keys.js";
import { readLocalPasskeys } from "./local-credentials.js";
import {
  LocalDirectoryError,
  readLocalDirectory,
  withLocalDirectoryLock,
} from "./local-directory.js";
import { notifyLocalIamChange } from "./local-iam-events.js";
import type { LocalAuthentication } from "./local-passkeys.js";
import { vaultStore } from "./vault/store.js";
import { VfsError, readFile, tombFileKey, writeFile } from "./vfs.js";

const PATH = "config/identity-sessions";
const LIFETIME_MS = 15 * 60_000;
const MAX_BYTES = 1_000_000;
const AUDIENCE = "opensesame:local-iam";

/** Display-safe handle. It grants no organization role or resource permission. */
export type LocalSession = Readonly<{
  id: string;
  principalId: string;
  authentication: "passkey" | "agent_key";
  authTime: number;
  expiresAt: number;
}>;
type SessionRecord = LocalSession & {
  digest: string;
  origin: string;
  audience: typeof AUDIENCE;
  directoryRevision: number;
  credentialId: string;
  credentialCreatedAt: number;
  publicKeyB64: string;
};

// Secrets stay in this tab, never in DTOs, URLs, storage, or model tool results.
let presentations = new WeakMap<
  LocalSession,
  { tomb: string; token: string }
>();
const activeSessions = new Map<string, LocalSession>();
vaultStore.onLock(() => {
  presentations = new WeakMap();
  activeSessions.clear();
  notifyLocalIamChange();
});

function invalid(): never {
  throw new LocalDirectoryError(
    "This local identity session is unavailable. Sign in again.",
  );
}
function integer(value: BoundaryValue): value is number {
  return isNumber(value) && Number.isSafeInteger(value) && value >= 0;
}
function text(value: BoundaryValue, max: number): value is string {
  return isString(value) && value.length > 0 && value.length <= max;
}
function isAuthentication(
  value: BoundaryValue,
): value is LocalSession["authentication"] {
  return value === "passkey" || value === "agent_key";
}
function isRecord(value: BoundaryValue): value is SessionRecord {
  return (
    isJsonObject(value) &&
    isAuthentication(value.authentication) &&
    text(value.id, 36) &&
    text(value.principalId, 42) &&
    text(value.digest, 43) &&
    /^[A-Za-z0-9_-]{43}$/.test(value.digest) &&
    text(value.origin, 2048) &&
    value.audience === AUDIENCE &&
    integer(value.directoryRevision) &&
    integer(value.credentialCreatedAt) &&
    text(value.credentialId, 2048) &&
    text(value.publicKeyB64, 8192) &&
    integer(value.authTime) &&
    integer(value.expiresAt) &&
    value.expiresAt - value.authTime === LIFETIME_MS
  );
}
function parseSessions(value: BoundaryValue): SessionRecord[] {
  if (
    !isJsonObject(value) ||
    (value.version !== 1 && value.version !== 2) ||
    !Array.isArray(value.sessions) ||
    value.sessions.length > 256
  )
    invalid();
  const records = value.sessions.map((record) => {
    if (value.version !== 1) return record;
    if (!isJsonObject(record) || "authentication" in record) invalid();
    return { ...record, authentication: "passkey" };
  });
  if (
    !records.every(isRecord) ||
    new Set(records.map((row) => row.id)).size !== records.length ||
    new Set(records.map((row) => row.digest)).size !== records.length
  )
    invalid();
  return records;
}

async function readSessions(tomb: string): Promise<SessionRecord[]> {
  await kvRefresh(tombFileKey(tomb, PATH), MAX_BYTES * 2);
  try {
    const bytes = await readFile(tomb, PATH);
    if (bytes.length > MAX_BYTES) invalid();
    const value: BoundaryValue = JSON.parse(new TextDecoder().decode(bytes));
    return parseSessions(value);
  } catch (error) {
    if (error instanceof VfsError && error.code === "not-found") return [];
    throw error;
  }
}
async function writeSessions(tomb: string, sessions: SessionRecord[]) {
  const bytes = new TextEncoder().encode(
    JSON.stringify({ version: 2, sessions }),
  );
  if (sessions.length > 256 || bytes.length > MAX_BYTES)
    throw new LocalDirectoryError(
      "Local session capacity reached. Revoke an unused session first.",
    );
  await writeFile(tomb, PATH, bytes);
}
async function requireCurrent(tomb: string, record: SessionRecord) {
  const now = Date.now();
  if (
    record.origin !== location.origin ||
    now < record.authTime ||
    now >= record.expiresAt
  )
    invalid();
  const directory = await readLocalDirectory(tomb);
  if (
    directory.revision !== record.directoryRevision ||
    !directory.entries.some(
      (person) =>
        person.id === record.principalId &&
        person.kind ===
          (record.authentication === "passkey" ? "person" : "agent") &&
        person.enabled,
    )
  )
    invalid();
  const keys =
    record.authentication === "passkey"
      ? await readLocalPasskeys(tomb)
      : await readLocalAgentKeys(tomb);
  if (
    !keys.some(
      (key) =>
        key.principalId === record.principalId &&
        key.credentialId === record.credentialId &&
        key.createdAt === record.credentialCreatedAt &&
        key.publicKeyB64 === record.publicKeyB64,
    )
  )
    invalid();
}
function publicSession(record: SessionRecord): LocalSession {
  return Object.freeze({
    id: record.id,
    principalId: record.principalId,
    authentication: record.authentication,
    authTime: record.authTime,
    expiresAt: record.expiresAt,
  });
}

/** Performs real WebAuthn verification; accepts no caller-asserted authentication. */
export async function signInLocalIdentity(
  tomb: string,
  principalId: string,
): Promise<LocalSession> {
  const activePresentations = presentations;
  const { authenticateLocalPasskey, consumeLocalAuthentication } = await import(
    "./local-passkeys.js"
  );
  const evidence = consumeLocalAuthentication(
    await authenticateLocalPasskey(tomb, principalId),
  );
  return createSession(tomb, evidence, "passkey", activePresentations);
}

/** An agent key proves machine identity, never human presence or consent. */
export async function signInLocalAgent(
  tomb: string,
  nonce: string,
  proof: string,
): Promise<LocalSession> {
  const activePresentations = presentations;
  const { authenticateLocalAgent, consumeLocalAgentAuthentication } =
    await import("./local-agent-auth.js");
  const evidence = consumeLocalAgentAuthentication(
    await authenticateLocalAgent(tomb, nonce, proof),
  );
  return createSession(tomb, evidence, "agent_key", activePresentations);
}

async function createSession(
  tomb: string,
  evidence: LocalAuthentication,
  authentication: LocalSession["authentication"],
  activePresentations: typeof presentations,
): Promise<LocalSession> {
  return withLocalDirectoryLock(tomb, async () => {
    if (activePresentations !== presentations || evidence.tomb !== tomb)
      invalid();
    const token = bytesToB64url(crypto.getRandomValues(new Uint8Array(32)));
    const record: SessionRecord = {
      id: crypto.randomUUID(),
      principalId: evidence.principalId,
      authentication,
      digest: await sha256Base64Url(token),
      origin: evidence.origin,
      audience: AUDIENCE,
      directoryRevision: evidence.directoryRevision,
      credentialId: evidence.credentialId,
      credentialCreatedAt: evidence.credentialCreatedAt,
      publicKeyB64: evidence.publicKeyB64,
      authTime: evidence.authTime,
      expiresAt: evidence.authTime + LIFETIME_MS,
    };
    await requireCurrent(tomb, record);
    const sessions = (await readSessions(tomb)).filter(
      (row) => row.expiresAt > Date.now(),
    );
    await writeSessions(tomb, [...sessions, record]);
    if (activePresentations !== presentations) invalid();
    const handle = publicSession(record);
    presentations.set(handle, { tomb, token });
    activeSessions.set(`${tomb}:${evidence.principalId}`, handle);
    notifyLocalIamChange();
    return handle;
  });
}

/** Consumers must additionally enforce their own organization/resource policy. */
export async function withLocalIdentitySession<T>(
  tomb: string,
  session: LocalSession,
  action: (identity: LocalSession, assertActive: () => void) => Promise<T>,
): Promise<T> {
  return withLocalDirectoryLock(tomb, async () => {
    const current = await sessionUnderLock(tomb, session);
    return action(current.identity, current.assertActive);
  });
}

async function sessionUnderLock(tomb: string, session: LocalSession) {
  const presentation = presentations.get(session);
  if (!presentation || presentation.tomb !== tomb) invalid();
  const digest = await sha256Base64Url(presentation.token);
  const record = (await readSessions(tomb)).find(
    (row) => row.id === session.id && row.digest === digest,
  );
  if (!record) invalid();
  await requireCurrent(tomb, record);
  const assertActive = () => {
    if (
      presentations.get(session) !== presentation ||
      record.origin !== location.origin ||
      Date.now() < record.authTime ||
      Date.now() >= record.expiresAt
    )
      invalid();
  };
  assertActive();
  return {
    identity: publicSession(record),
    credentialId: record.credentialId,
    assertActive,
  };
}

/** Validate both presentations under one fence; never nest lock acquisition. */
export async function withLocalIdentityPair<T>(
  tomb: string,
  principal: LocalSession,
  approver: LocalSession,
  action: (
    principal: LocalSession,
    approver: LocalSession,
    assertActive: () => void,
    principalCredentialId: string,
  ) => Promise<T>,
): Promise<T> {
  return withLocalDirectoryLock(tomb, async () => {
    const subject = await sessionUnderLock(tomb, principal);
    const human = await sessionUnderLock(tomb, approver);
    const assertActive = () => {
      subject.assertActive();
      human.assertActive();
    };
    assertActive();
    return action(
      subject.identity,
      human.identity,
      assertActive,
      subject.credentialId,
    );
  });
}

/** Human vault-custodian session administration, not an agent-facing API. */
export async function listLocalIdentitySessions(
  tomb: string,
): Promise<LocalSession[]> {
  return withLocalDirectoryLock(tomb, async () =>
    (await readSessions(tomb))
      .filter((row) => row.expiresAt > Date.now())
      .map(publicSession),
  );
}
export async function revokeLocalIdentitySession(
  tomb: string,
  id: string,
): Promise<void> {
  return withLocalDirectoryLock(tomb, async () => {
    const sessions = await readSessions(tomb);
    await writeSessions(
      tomb,
      sessions.filter((row) => row.id !== id),
    );
    for (const [key, session] of activeSessions) {
      if (session.id === id) activeSessions.delete(key);
    }
    notifyLocalIamChange();
  });
}

/** Reopening a panel recovers the same tab-owned presentation, never a copied DTO. */
export async function currentLocalIdentitySession(
  tomb: string,
  principalId: string,
): Promise<LocalSession | null> {
  const key = `${tomb}:${principalId}`;
  const session = activeSessions.get(key);
  if (!session) return null;
  try {
    await withLocalIdentitySession(tomb, session, async () => undefined);
    return session;
  } catch (error) {
    if (activeSessions.get(key) === session) activeSessions.delete(key);
    if (
      error instanceof LocalDirectoryError ||
      (error instanceof VfsError && error.code === "locked")
    )
      return null;
    throw error;
  }
}

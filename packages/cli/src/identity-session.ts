/**
 * The Identity session file for `opensesame-id`: owner-only on disk, refreshed
 * against the issuer that minted it.
 */
import { randomBytes } from "node:crypto";
import {
  access,
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { loadAtRestKeyFile } from "@opensesame/app-core/node/at-rest-key-file.js";
import {
  openLocalEnvelope,
  sealLocalEnvelope,
} from "@opensesame/app-core/node/local-envelope.js";
import {
  type BoundaryValue,
  isJsonObject,
  isNumber,
  isString,
  overlapCast,
} from "@opensesame/os-domain";
import { z } from "zod";
import { errorLine } from "./output.js";
import { type SessionFile, SessionFileSchema } from "./parse.js";

interface OidcDiscoveryResponse {
  token_endpoint?: BoundaryValue;
}

interface RefreshTokenResponse {
  access_token?: BoundaryValue;
  refresh_token?: BoundaryValue;
  expires_in?: BoundaryValue;
}

function sessionPath(): string {
  // An explicit setting outranks the ambient one: OPENSESAME_STATE_DIR is a choice,
  // XDG_RUNTIME_DIR is whatever the session manager happened to export.
  const base =
    process.env.OPENSESAME_STATE_DIR ??
    process.env.XDG_RUNTIME_DIR ??
    join(homedir(), ".config", "opensesame");
  return join(base, "identity-session.json");
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/u, "");
}

const REFRESH_LOCK_WAIT_MS = 10_000;
const REFRESH_LOCK_STALE_MS = 30_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Serialize the read-refresh-write window across processes. In-process callers
 * already share `refreshes`; two CLI invocations do not, and rotating refresh
 * tokens mean the loser's token is already revoked. The lock file lives beside
 * the session and is removed by its holder.
 */
async function acquireRefreshLock(): Promise<() => Promise<void>> {
  const path = `${sessionPath()}.lock`;
  const deadline = Date.now() + REFRESH_LOCK_WAIT_MS;
  for (;;) {
    try {
      const handle = await open(path, "wx", 0o600);
      try {
        await handle.writeFile(`${process.pid}\n`);
      } finally {
        await handle.close();
      }
      return async () => {
        await rm(path, { force: true });
      };
    } catch (error) {
      if (
        typeof error !== "object" ||
        error === null ||
        !("code" in error) ||
        error.code !== "EEXIST"
      )
        throw error;
      try {
        const info = await stat(path);
        if (Date.now() - info.mtimeMs > REFRESH_LOCK_STALE_MS) {
          await rm(path, { force: true });
          continue;
        }
      } catch {
        // The holder released it between our open and stat; retry.
      }
      if (Date.now() >= deadline)
        throw new Error("Session refresh lock is held by another process");
      await sleep(25);
    }
  }
}

/**
 * Refuse a session file anyone but its owner can read or write. A bearer token in
 * a group-readable file is a bearer token every account on the box holds, and one
 * in a writable file is a token another account gets to choose.
 */
async function assertPrivateFile(path: string): Promise<void> {
  if (process.platform === "win32") return;
  const info = await stat(path);
  if ((info.mode & 0o077) !== 0) {
    throw new Error(
      `${path} is readable or writable by others (mode ${(info.mode & 0o777).toString(8)}); refusing to use it`,
    );
  }
}

const EnvelopeSchema = z.object({
  version: z.literal(1),
  issuer: z.string(),
  clientId: z.string(),
  sealed: z.string(),
});
function binding(issuer: string, clientId: string): string {
  return JSON.stringify(["cli_identity_session", trimSlash(issuer), clientId]);
}
async function sessionRoot(path: string, create = true): Promise<Uint8Array> {
  const keyPath = join(dirname(path), "identity-session.key");
  let exists = false;
  try {
    await access(keyPath);
    exists = true;
  } catch {
    /* New installation. */
  }
  if (!exists && !create) throw new Error("Session envelope root is missing");
  if (exists) await assertPrivateFile(keyPath);
  return loadAtRestKeyFile(keyPath);
}

export async function loadSession(): Promise<SessionFile | null> {
  const path = sessionPath();
  try {
    await assertPrivateFile(path);
  } catch (err) {
    // A first run has no session; that is not an error on every command.
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      err.code === "ENOENT"
    )
      return null;
    // Loud, not silent: a session the CLI will not touch is worth saying out loud.
    process.stderr.write(errorLine(overlapCast(err)));
    return null;
  }
  try {
    const raw = await readFile(path, "utf8");
    const parsed = overlapCast(JSON.parse(raw));
    const envelope = EnvelopeSchema.safeParse(parsed);
    if (!envelope.success) {
      if (isJsonObject(parsed) && ("version" in parsed || "sealed" in parsed))
        return null;
      const legacy = SessionFileSchema.parse(parsed);
      await saveSession(legacy);
      return legacy;
    }
    const outer = envelope.data;
    const root = await sessionRoot(path, false);
    let plaintext: string | null;
    try {
      plaintext = openLocalEnvelope(
        root,
        binding(outer.issuer, outer.clientId),
        outer.sealed,
      );
    } finally {
      root.fill(0);
    }
    if (plaintext === null) return null;
    const session = SessionFileSchema.parse(JSON.parse(plaintext));
    if (
      binding(session.issuer, session.clientId) !==
      binding(outer.issuer, outer.clientId)
    )
      return null;
    return session;
  } catch {
    return null;
  }
}

function sessionMatchesIssuer(
  session: SessionFile | null,
  issuer: string,
): SessionFile | null {
  if (!session) return null;
  if (trimSlash(session.issuer) !== trimSlash(issuer)) return null;
  return session;
}

async function refreshSession(
  session: SessionFile,
  fetchImpl: typeof fetch,
): Promise<SessionFile | null> {
  if (!session.refreshToken) return null;
  try {
    const discovery = await fetchImpl(
      `${trimSlash(session.issuer)}/.well-known/openid-configuration`,
    );
    if (!discovery.ok) return null;
    const meta: OidcDiscoveryResponse = overlapCast(await discovery.json());
    const tokenEndpoint = meta.token_endpoint;
    if (!isString(tokenEndpoint)) return null;
    const issuerOrigin = new URL(session.issuer).origin;
    if (new URL(tokenEndpoint).origin !== issuerOrigin) return null;
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: session.refreshToken,
      client_id: session.clientId,
    });
    const res = await fetchImpl(tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!res.ok) return null;
    const tokens: RefreshTokenResponse = overlapCast(await res.json());
    if (!isString(tokens.access_token)) return null;
    const next: SessionFile = {
      ...session,
      accessToken: tokens.access_token,
      refreshToken: isString(tokens.refresh_token)
        ? tokens.refresh_token
        : session.refreshToken,
      ...(isNumber(tokens.expires_in)
        ? { expiresAt: Date.now() + tokens.expires_in * 1000 }
        : undefined),
    };
    try {
      await saveSession(next);
    } catch {
      // The issuer already rotated the token, so the file on disk holds a
      // refresh token that can no longer be used. Remove it rather than keep
      // presenting a dead session; the next command can sign in cleanly.
      await clearSession();
      return null;
    }
    return next;
  } catch {
    return null;
  }
}

/**
 * A session is only the session for the issuer that minted it, and only until it
 * expires. An expired access token is refreshed when a refresh token is present.
 */
const refreshes = new Map<string, Promise<SessionFile | null>>();

/** One refresh per session, so parallel commands cannot rotate the same token twice. */
function refreshOnce(
  session: SessionFile,
  fetchImpl: typeof fetch,
): Promise<SessionFile | null> {
  const key = `${session.issuer}\n${session.clientId}`;
  const existing = refreshes.get(key);
  if (existing) return existing;
  const run = refreshAcrossProcesses(session, fetchImpl).finally(() => {
    if (refreshes.get(key) === run) refreshes.delete(key);
  });
  refreshes.set(key, run);
  return run;
}

/**
 * Acquire the cross-process lock, then reload the session: another command may
 * have refreshed it while this one waited. Only the holder that still sees an
 * expired session performs the rotation.
 */
async function refreshAcrossProcesses(
  session: SessionFile,
  fetchImpl: typeof fetch,
): Promise<SessionFile | null> {
  let release: (() => Promise<void>) | null;
  try {
    release = await acquireRefreshLock();
  } catch {
    const current = sessionMatchesIssuer(await loadSession(), session.issuer);
    return current &&
      current.clientId === session.clientId &&
      (current.expiresAt === undefined || current.expiresAt > Date.now())
      ? current
      : null;
  }
  try {
    const current = sessionMatchesIssuer(await loadSession(), session.issuer);
    const next =
      current && current.clientId === session.clientId ? current : session;
    if (next.expiresAt === undefined || next.expiresAt > Date.now())
      return next;
    return await refreshSession(next, fetchImpl);
  } finally {
    await release().catch(() => undefined);
  }
}

export async function sessionFor(
  session: SessionFile | null,
  issuer: string,
  fetchImpl: typeof fetch,
): Promise<SessionFile | null> {
  const matched = sessionMatchesIssuer(session, issuer);
  if (!matched) return null;
  if (matched.expiresAt === undefined || matched.expiresAt > Date.now()) {
    return matched;
  }
  return refreshOnce(matched, fetchImpl);
}

export async function saveSession(session: SessionFile): Promise<void> {
  const path = sessionPath();
  // `mode` on writeFile only applies when the file is created, so a file left
  // behind at 0644 by an earlier version would keep those bits forever.
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  const root = await sessionRoot(path);
  let sealed: string;
  try {
    sealed = sealLocalEnvelope(
      root,
      binding(session.issuer, session.clientId),
      JSON.stringify(session),
    );
  } finally {
    root.fill(0);
  }
  const envelope = {
    version: 1,
    issuer: session.issuer,
    clientId: session.clientId,
    sealed,
  };
  let committed = false;
  try {
    await writeFile(temp, JSON.stringify(envelope), {
      mode: 0o600,
      flag: "wx",
    });
    await chmod(temp, 0o600);
    await rename(temp, path);
    committed = true;
  } finally {
    // A failed write or rename must not leave a sealed bearer token behind in
    // a predictable temp name beside the session file.
    if (!committed) await rm(temp, { force: true }).catch(() => undefined);
  }
}

export async function clearSession(): Promise<void> {
  try {
    await rm(sessionPath(), { force: true });
  } catch {
    // ignore
  }
}

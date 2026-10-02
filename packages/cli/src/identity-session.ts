/**
 * The Identity session file for `opensesame-id`: owner-only on disk, refreshed
 * against the issuer that minted it.
 */
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  type BoundaryValue,
  isNumber,
  isString,
  overlapCast,
} from "@opensesame/os-domain";
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

export async function loadSession(): Promise<SessionFile | null> {
  const path = sessionPath();
  try {
    await assertPrivateFile(path);
  } catch (err) {
    // Loud, not silent: a session the CLI will not touch is worth saying out loud.
    process.stderr.write(
      `${err instanceof Error ? err.message : String(err)}\n`,
    );
    return null;
  }
  try {
    const raw = await readFile(path, "utf8");
    return SessionFileSchema.parse(JSON.parse(raw));
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
    await saveSession(next);
    return next;
  } catch {
    return null;
  }
}

/**
 * A session is only the session for the issuer that minted it, and only until it
 * expires. An expired access token is refreshed when a refresh token is present.
 */
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
  return refreshSession(matched, fetchImpl);
}

export async function saveSession(session: SessionFile): Promise<void> {
  const path = sessionPath();
  // `mode` on writeFile only applies when the file is created, so a file left
  // behind at 0644 by an earlier version would keep those bits forever.
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(session), { mode: 0o600 });
  await chmod(temp, 0o600);
  await rename(temp, path);
}

export async function clearSession(): Promise<void> {
  try {
    await rm(sessionPath(), { force: true });
  } catch {
    // ignore
  }
}

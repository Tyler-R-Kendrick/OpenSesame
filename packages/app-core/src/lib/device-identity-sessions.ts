/**
 * The device host's sessions and principal (ADR 0118, ADR 0160).
 *
 * A session is a bearer held in this tab's memory and nowhere else. What the
 * bearer stands for depends on the vault it was minted in:
 *
 * - **No vault yet:** a random provisional principal, unbound. Nothing durable
 *   exists to derive one from.
 * - **Unlocked vault (member or guest):** the principal is `prn_` + the
 *   thumbprint of the vault's identity key (`device-identity-key.ts`), and
 *   the session is bound to that tomb and key. A guest's is `provisional`
 *   and lives in the guest tomb; a member's is `active`.
 * - **Locked vault:** nothing is issued, and a session bound to a vault
 *   answers `locked` (423) until that same vault opens again. A different
 *   vault opening ends it: a bearer never follows a person across vaults.
 *
 * Assurance is always `provisional`. A local passkey session proves that a
 * local *person* signed in to this vault; nothing binds that person to this
 * device principal, so raising the principal on it would claim a proof that
 * was never about it. The vault being open is not an assurance claim either.
 */

import type { JsonObject } from "@opensesame/os-domain";
import { bytesToB64url } from "@opensesame/sdk-browser";
import {
  DeviceIdentityKeyError,
  type DeviceIdentityKeyFault,
  ensureDeviceIdentityKey,
  readDeviceIdentityKey,
} from "./device-identity-key.js";
import type { DeviceCaller } from "./device-identity-routes.js";
import { deviceVaultView } from "./device-identity-vault.js";
import { VfsError } from "./vfs.js";

const PROVISIONAL_TTL_MS = 24 * 60 * 60 * 1000;

type Binding = { tomb: string; guest: boolean; keyId: string };

type DeviceSession = {
  principalId: string;
  accessToken: string;
  expiresAtMs: number;
  binding: Binding | null;
};

const sessionsByToken = new Map<string, DeviceSession>();

export function json(
  body: JsonObject,
  status = 200,
  headers?: HeadersInit,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...(headers ?? {}) },
  });
}

/** The answer for a vault that is on this device and not open. */
export function lockedResponse(): Response {
  return json(
    {
      error: "locked",
      hint: "Unlock the vault on this device to use its identity.",
    },
    423,
  );
}

export function bearerFrom(init: RequestInit): string | null {
  const auth = new Headers(init.headers).get("authorization");
  if (auth?.toLowerCase().startsWith("bearer ")) {
    const token = auth.slice(7).trim();
    return token.length > 0 ? token : null;
  }
  return null;
}

function liveSession(token: string | null): DeviceSession | null {
  if (!token) return null;
  const row = sessionsByToken.get(token);
  if (!row) return null;
  if (row.expiresAtMs <= Date.now()) {
    sessionsByToken.delete(token);
    return null;
  }
  return row;
}

export type DeviceAuthentication =
  | { ok: true; session: DeviceSession; caller: DeviceCaller }
  | { ok: false; response: Response };

/** Drop a session and answer 401: what a bearer that no longer stands gets. */
function ended(session: DeviceSession): DeviceAuthentication {
  sessionsByToken.delete(session.accessToken);
  return { ok: false, response: json({ error: "unauthorized" }, 401) };
}

/**
 * Does the vault open now still hold the key this session was bound to? A
 * tomb has a fixed name (`guest` above all), so the name proves nothing: a
 * tomb recreated or restored with another key is another principal, and the
 * old bearer must not speak for it. Anything unreadable fails closed.
 */
async function stillBound(binding: Binding): Promise<boolean | "locked"> {
  try {
    const key = await readDeviceIdentityKey(binding.tomb);
    return key !== null && key.keyId === binding.keyId;
  } catch (error) {
    return error instanceof VfsError && error.code === "locked"
      ? "locked"
      : false;
  }
}

/**
 * Resolve a request's bearer against the vault as it is *now*. A bound
 * session answers `locked` while its vault is shut and is ended when another
 * vault is open or the open one no longer holds its key; an unbound one is
 * valid until it expires.
 */
export async function authenticateDevice(
  init: RequestInit,
): Promise<DeviceAuthentication> {
  const session = liveSession(bearerFrom(init));
  if (!session) {
    return { ok: false, response: json({ error: "unauthorized" }, 401) };
  }
  const caller = (tomb: string, guest: boolean): DeviceCaller => ({
    principalId: session.principalId,
    tomb,
    guest,
  });
  const { binding } = session;
  if (!binding) return { ok: true, session, caller: caller("", false) };
  const view = deviceVaultView();
  if (view.kind === "locked") return { ok: false, response: lockedResponse() };
  if (view.kind !== "unlocked" || view.tomb !== binding.tomb) {
    return ended(session);
  }
  const held = await stillBound(binding);
  if (held === "locked") return { ok: false, response: lockedResponse() };
  if (!held) return ended(session);
  return { ok: true, session, caller: caller(binding.tomb, binding.guest) };
}

function randomPrincipal(): string {
  return `prn_${bytesToB64url(crypto.getRandomValues(new Uint8Array(12)))}`;
}

/** The principal for what is open now, or a response that says why not. */
async function principalForNow(): Promise<
  | {
      principalId: string;
      binding: Binding | null;
      /** Why a vault is open but its principal is not its key's. */
      identityKey?: DeviceIdentityKeyFault;
    }
  | { response: Response }
> {
  const view = deviceVaultView();
  if (view.kind === "locked") return { response: lockedResponse() };
  if (view.kind === "none") {
    return { principalId: randomPrincipal(), binding: null };
  }
  try {
    const key = await ensureDeviceIdentityKey(view.tomb);
    // The vault may have locked, or another opened, while the key was read.
    const after = deviceVaultView();
    if (after.kind !== "unlocked" || after.tomb !== view.tomb) {
      return { response: lockedResponse() };
    }
    return {
      principalId: key.principalId,
      binding: { tomb: view.tomb, guest: view.guest, keyId: key.keyId },
    };
  } catch (error) {
    if (error instanceof VfsError && error.code === "locked") {
      return { response: lockedResponse() };
    }
    // The key cannot be had (a record this build cannot read, or no cross-tab
    // lock to mint one under). A provisional session still opens, as it did
    // before there was a key: random, unbound, provisional, and said so in the
    // answer. The record is never touched, and nothing here claims more.
    if (error instanceof DeviceIdentityKeyError) {
      return {
        principalId: randomPrincipal(),
        binding: null,
        identityKey: error.code,
      };
    }
    return {
      response: json(
        {
          error: "unreachable",
          hint: "The identity key for this vault could not be read.",
        },
        503,
      ),
    };
  }
}

export async function mintProvisional(): Promise<Response> {
  const now = Date.now();
  for (const [token, row] of sessionsByToken) {
    if (row.expiresAtMs <= now) sessionsByToken.delete(token);
  }
  const principal = await principalForNow();
  if ("response" in principal) return principal.response;
  const accessToken = `dev_${bytesToB64url(crypto.getRandomValues(new Uint8Array(24)))}`;
  const expiresAtMs = now + PROVISIONAL_TTL_MS;
  sessionsByToken.set(accessToken, {
    principalId: principal.principalId,
    accessToken,
    expiresAtMs,
    binding: principal.binding,
  });
  const body: JsonObject = {
    principalId: principal.principalId,
    accessToken,
    expiresAt: new Date(expiresAtMs).toISOString(),
  };
  // Said only when a vault is open and its key could not be had.
  if (principal.identityKey) body.identityKey = principal.identityKey;
  return json(body, 201);
}

export function revokeProvisional(init: RequestInit): Response {
  const token = bearerFrom(init);
  if (token) sessionsByToken.delete(token);
  return json({ revoked: true });
}

export async function principalsMe(init: RequestInit): Promise<Response> {
  const auth = await authenticateDevice(init);
  if (!auth.ok) return auth.response;
  const { session } = auth;
  const issued = new Date(
    session.expiresAtMs - PROVISIONAL_TTL_MS,
  ).toISOString();
  const keyed = session.binding !== null && !session.binding.guest;
  return json({
    id: session.principalId,
    state: keyed ? "active" : "provisional",
    assurance: "provisional",
    createdAt: issued,
    updatedAt: new Date().toISOString(),
    version: 1,
    identities: [],
  });
}

/** Test seam — wipe provisional sessions. */
export function resetDeviceIdentitySessionsForTests(): void {
  sessionsByToken.clear();
}

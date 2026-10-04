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
import { ensureDeviceIdentityKey } from "./device-identity-key.js";
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

/**
 * Resolve a request's bearer against the vault as it is *now*. A bound
 * session answers `locked` while its vault is shut and is ended when another
 * vault is open; an unbound one is valid until it expires.
 */
export function authenticateDevice(init: RequestInit): DeviceAuthentication {
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
    sessionsByToken.delete(session.accessToken);
    return { ok: false, response: json({ error: "unauthorized" }, 401) };
  }
  return { ok: true, session, caller: caller(binding.tomb, binding.guest) };
}

function randomPrincipal(): string {
  return `prn_${bytesToB64url(crypto.getRandomValues(new Uint8Array(12)))}`;
}

/** The principal for what is open now, or a response that says why not. */
async function principalForNow(): Promise<
  { principalId: string; binding: Binding | null } | { response: Response }
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
  return json(
    {
      principalId: principal.principalId,
      accessToken,
      expiresAt: new Date(expiresAtMs).toISOString(),
    },
    201,
  );
}

export function revokeProvisional(init: RequestInit): Response {
  const token = bearerFrom(init);
  if (token) sessionsByToken.delete(token);
  return json({ revoked: true });
}

export async function principalsMe(init: RequestInit): Promise<Response> {
  const auth = authenticateDevice(init);
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

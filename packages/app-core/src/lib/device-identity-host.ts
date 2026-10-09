/**
 * In-tab Identity API for device-native mode (ADR 0118, ADR 0160).
 *
 * Serves the `/v1/*` surface Pages already speaks — provisional principals,
 * claims (drops), health — against vault-local stores. A configured remote
 * Identity API overrides this whole module. Sessions and the key-backed
 * principal live in `device-identity-sessions.ts`; every other family is a
 * capability's contribution to `device-identity-routes.ts`.
 */

import {
  type BoundaryValue,
  type JsonObject,
  isNumber,
  isString,
  isTypeofObject,
  overlapCast,
} from "@opensesame/os-domain";
import { dispatchDeviceRoute, familyOfPath } from "./device-identity-routes.js";
import {
  authenticateDevice,
  bearerFrom,
  json,
  lockedResponse,
  mintProvisional,
  principalsMe,
  resetDeviceIdentitySessionsForTests,
  revokeProvisional,
} from "./device-identity-sessions.js";
import { deviceVaultView } from "./device-identity-vault.js";
import {
  LocalDropClaimError,
  createLocalDropClaim,
  pollLocalDropClaim,
  presentLocalDropClaim,
} from "./vault/local-drop-claims.js";

export { resetDeviceIdentitySessionsForTests };

const DROP_CLAIM_TYPE = "resource_bundle";

function obj(value: BoundaryValue): Record<string, BoundaryValue> {
  if (isTypeofObject(value) && !Array.isArray(value)) {
    return overlapCast(value);
  }
  return {};
}

/** The request body when it is a string, else null. */
function stringBody(init: RequestInit): string | null {
  const raw: BoundaryValue = overlapCast(init.body);
  return isString(raw) ? raw : null;
}

async function readJson(init: RequestInit): Promise<JsonObject> {
  const raw = stringBody(init);
  if (raw === null || raw.length === 0) return {};
  try {
    const parsed: BoundaryValue = overlapCast(JSON.parse(raw));
    return overlapCast(obj(parsed));
  } catch {
    return {};
  }
}

function claimTokenFrom(init: RequestInit): string | null {
  const headers = new Headers(init.headers);
  const claim = headers.get("x-claim-token");
  if (claim?.trim()) return claim.trim();
  return bearerFrom(init);
}

async function createClaim(init: RequestInit): Promise<Response> {
  const auth = await authenticateDevice(init);
  if (!auth.ok) return auth.response;
  const body = await readJson(init);
  const manifest = body.targetManifest;
  if (!isTypeofObject(manifest) || Array.isArray(manifest)) {
    return json(
      { error: "validation_error", hint: "targetManifest is required." },
      400,
    );
  }
  const ttlSeconds = isNumber(body.ttlSeconds) ? body.ttlSeconds : 900;
  try {
    const created = await createLocalDropClaim(
      overlapCast(manifest),
      Math.max(1, ttlSeconds) * 1000,
    );
    return json(
      {
        claimId: created.claimId,
        claimToken: created.bearerToken,
        userCode: created.userCode,
        verificationUri: created.verifyUrl,
        expiresAt: created.expiresAt,
        pollIntervalSeconds: 5,
        type: isString(body.type) ? body.type : DROP_CLAIM_TYPE,
      },
      201,
    );
  } catch (error) {
    if (error instanceof LocalDropClaimError) {
      return json({ error: error.code, hint: error.message }, 400);
    }
    return json(
      { error: "unreachable", hint: "Claim could not be minted." },
      503,
    );
  }
}

async function pollClaim(
  claimId: string,
  init: RequestInit,
): Promise<Response> {
  const token = claimTokenFrom(init);
  if (!token) return json({ error: "unauthorized" }, 401);
  try {
    const status = await pollLocalDropClaim(claimId, token);
    return json({ status, claim: { state: status } });
  } catch (error) {
    if (error instanceof LocalDropClaimError) {
      return json({ error: error.code, hint: error.message }, 401);
    }
    return json({ error: "unreachable" }, 503);
  }
}

async function presentClaim(init: RequestInit): Promise<Response> {
  const body = await readJson(init);
  const token = isString(body.token) ? body.token : "";
  const userCode = isString(body.userCode) ? body.userCode : "";
  if (!token || !userCode) {
    return json(
      { error: "validation_error", hint: "token and userCode are required." },
      400,
    );
  }
  try {
    const presented = await presentLocalDropClaim(token, userCode);
    return json({
      claimId: presented.claimId,
      status: presented.state,
      targetManifest: presented.targetManifest,
    });
  } catch (error) {
    if (error instanceof LocalDropClaimError) {
      // The Identity API's code for the same refusal, read by one wording.
      return json(
        {
          error: error.wire,
          hint: error.message,
          attemptsLeft: error.attemptsLeft ?? null,
        },
        401,
      );
    }
    return json({ error: "unreachable" }, 503);
  }
}

function healthLive(): Response {
  return json({ status: "ok" });
}

/** Email and text codes need a sender no browser tab is. */
function mfaUnavailable(): Response {
  return json(
    {
      error: "not_configured",
      hint: "Email and text codes need a connected sign-in service.",
    },
    503,
  );
}

function notImplemented(path: string): Response {
  return json(
    {
      error: "device_identity",
      hint: `This device identity host does not implement ${path}. Use the matching local Identity screen, or connect a sign-in service if your organisation provides one.`,
    },
    501,
  );
}

function matchCorePath(
  path: string,
):
  | { kind: "exact"; route: string }
  | { kind: "poll"; claimId: string }
  | { kind: "other" } {
  const bare = path.split("?")[0] ?? path;
  if (bare === "/v1/health/live") return { kind: "exact", route: "health" };
  if (bare === "/v1/principals/provisional") {
    return { kind: "exact", route: "provisional" };
  }
  if (bare === "/v1/principals/provisional/revoke") {
    return { kind: "exact", route: "revoke" };
  }
  if (bare === "/v1/principals/me") return { kind: "exact", route: "me" };
  if (bare === "/v1/claims") return { kind: "exact", route: "claims" };
  if (bare === "/v1/claims/present") {
    return { kind: "exact", route: "present" };
  }
  const poll = /^\/v1\/claims\/([^/]+)\/poll$/.exec(bare);
  if (poll?.[1]) {
    try {
      return { kind: "poll", claimId: decodeURIComponent(poll[1]) };
    } catch {
      return { kind: "other" };
    }
  }
  return { kind: "other" };
}

/**
 * Dispatch an Identity-plane path against the device-native host.
 * `path` is absolute from the plane root (`/v1/...`).
 */
async function handleCoreRoute(
  route: string,
  method: string,
  init: RequestInit,
): Promise<Response> {
  const notAllowed = () => json({ error: "method_not_allowed" }, 405);
  if (route === "health") return method === "GET" ? healthLive() : notAllowed();
  if (route === "provisional") {
    return method === "POST" ? mintProvisional() : notAllowed();
  }
  if (route === "revoke") {
    return method === "POST" ? revokeProvisional(init) : notAllowed();
  }
  if (route === "me") {
    return method === "GET" ? principalsMe(init) : notAllowed();
  }
  if (route === "claims") {
    return method === "POST" ? createClaim(init) : notAllowed();
  }
  return method === "POST" ? presentClaim(init) : notAllowed();
}

type Matched = ReturnType<typeof matchCorePath>;

/**
 * `POST /v1/claims` stays gated on a locked vault (ADR 0160 §7). Sealing is
 * an act of the open vault, and a session minted before any vault existed
 * gets no exemption. Poll and present only touch the origin claim store, so
 * they run while this vault is locked.
 */
function createClaimWhileLocked(matched: Matched): boolean {
  return (
    matched.kind === "exact" &&
    matched.route === "claims" &&
    deviceVaultView().kind === "locked"
  );
}

/** A capability's route, or what the host answers for it itself. */
async function capabilityRoute(
  path: string,
  method: string,
  init: RequestInit,
): Promise<Response> {
  const bare = path.split("?")[0] ?? path;
  // A capability's routes read the vault and its directory. While a vault
  // on this device is shut they answer `locked`; they never fall back.
  if (deviceVaultView().kind === "locked") return lockedResponse();
  // What needs a server is answered here, whoever is registered.
  if (familyOfPath(bare) === "mfa-codes") return mfaUnavailable();
  const auth = await authenticateDevice(init);
  // A handler is given the resolved caller and the body, never a header.
  const answered = await dispatchDeviceRoute({
    path,
    bare,
    method,
    body: stringBody(init),
    caller: auth.ok ? auth.caller : null,
  });
  return answered ?? notImplemented(bare);
}

export async function deviceIdentityFetch(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const method = (init.method ?? "GET").toUpperCase();
  const matched = matchCorePath(path);
  if (createClaimWhileLocked(matched)) return lockedResponse();
  if (matched.kind === "poll") {
    if (method !== "GET") return json({ error: "method_not_allowed" }, 405);
    return pollClaim(matched.claimId, init);
  }
  if (matched.kind === "other") return capabilityRoute(path, method, init);
  return handleCoreRoute(matched.route, method, init);
}

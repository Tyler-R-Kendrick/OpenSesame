/**
 * In-tab Identity API for device-native mode (ADR 0118).
 *
 * Serves the `/v1/*` surface Pages already speaks — provisional principals,
 * claims (drops), health — against vault-local stores. A configured remote
 * Identity API overrides this whole module.
 */

import {
  type BoundaryValue,
  type JsonObject,
  isNumber,
  isString,
  isTypeofObject,
  overlapCast,
} from "@opensesame/os-domain";
import { bytesToB64url } from "@opensesame/sdk-browser";
import {
  LocalDropClaimError,
  createLocalDropClaim,
  pagesClaimBase,
  pollLocalDropClaim,
  presentLocalDropClaim,
} from "./vault/local-drop-claims.js";

const PROVISIONAL_TTL_MS = 24 * 60 * 60 * 1000;
const DROP_CLAIM_TYPE = "resource_bundle";

type DeviceSession = {
  principalId: string;
  accessToken: string;
  expiresAtMs: number;
};

const sessionsByToken = new Map<string, DeviceSession>();

function json(body: JsonObject, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      ...(headers ?? {}),
    },
  });
}

function obj(value: BoundaryValue): Record<string, BoundaryValue> {
  if (isTypeofObject(value) && !Array.isArray(value)) {
    return overlapCast(value);
  }
  return {};
}

async function readJson(init: RequestInit): Promise<JsonObject> {
  const raw: BoundaryValue = overlapCast(init.body);
  if (!isString(raw) || raw.length === 0) return {};
  try {
    const parsed: BoundaryValue = overlapCast(JSON.parse(raw));
    return overlapCast(obj(parsed));
  } catch {
    return {};
  }
}

function sessionBearerFrom(init: RequestInit): string | null {
  const headers = new Headers(init.headers);
  const auth = headers.get("authorization");
  if (auth?.toLowerCase().startsWith("bearer ")) {
    const token = auth.slice(7).trim();
    return token.length > 0 ? token : null;
  }
  return null;
}

function claimTokenFrom(init: RequestInit): string | null {
  const headers = new Headers(init.headers);
  const claim = headers.get("x-claim-token");
  if (claim?.trim()) return claim.trim();
  return sessionBearerFrom(init);
}

function bearerFrom(init: RequestInit): string | null {
  return sessionBearerFrom(init);
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

function mintProvisional(): Response {
  const principalId = `prn_${bytesToB64url(crypto.getRandomValues(new Uint8Array(12)))}`;
  const accessToken = `dev_${bytesToB64url(crypto.getRandomValues(new Uint8Array(24)))}`;
  const expiresAtMs = Date.now() + PROVISIONAL_TTL_MS;
  sessionsByToken.set(accessToken, { principalId, accessToken, expiresAtMs });
  return json(
    {
      principalId,
      accessToken,
      expiresAt: new Date(expiresAtMs).toISOString(),
    },
    201,
  );
}

function revokeProvisional(init: RequestInit): Response {
  const token = bearerFrom(init);
  if (token) sessionsByToken.delete(token);
  return json({ revoked: true });
}

function principalsMe(init: RequestInit): Response {
  const session = liveSession(bearerFrom(init));
  if (!session) return json({ error: "unauthorized" }, 401);
  const now = new Date().toISOString();
  return json({
    id: session.principalId,
    state: "provisional",
    assurance: "provisional",
    createdAt: now,
    updatedAt: now,
    version: 1,
    identities: [],
  });
}

async function createClaim(init: RequestInit): Promise<Response> {
  if (!liveSession(bearerFrom(init))) {
    return json({ error: "unauthorized" }, 401);
  }
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
      return json({ error: error.code, hint: error.message }, 401);
    }
    return json({ error: "unreachable" }, 503);
  }
}

function healthLive(): Response {
  return json({ status: "ok" });
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
  if (poll?.[1]) return { kind: "poll", claimId: decodeURIComponent(poll[1]) };
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
  path: string,
): Promise<Response> {
  if (route === "health") {
    return method === "GET"
      ? healthLive()
      : json({ error: "method_not_allowed" }, 405);
  }
  if (route === "provisional") {
    return method === "POST"
      ? mintProvisional()
      : json({ error: "method_not_allowed" }, 405);
  }
  if (route === "revoke") {
    return method === "POST"
      ? revokeProvisional(init)
      : json({ error: "method_not_allowed" }, 405);
  }
  if (route === "me") {
    return method === "GET"
      ? principalsMe(init)
      : json({ error: "method_not_allowed" }, 405);
  }
  if (route === "claims") {
    return method === "POST"
      ? createClaim(init)
      : json({ error: "method_not_allowed" }, 405);
  }
  if (route === "present") {
    return method === "POST"
      ? presentClaim(init)
      : json({ error: "method_not_allowed" }, 405);
  }
  return notImplemented(path);
}

export async function deviceIdentityFetch(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const method = (init.method ?? "GET").toUpperCase();
  const matched = matchCorePath(path);

  if (matched.kind === "poll") {
    if (method !== "GET") return json({ error: "method_not_allowed" }, 405);
    return pollClaim(matched.claimId, init);
  }
  if (matched.kind === "other") {
    // The local IAM routes sit above this host (they read the vault and the
    // local directory), so they load on first use rather than at import.
    const { dispatchExtendedDeviceRoute } = await import(
      "./device-identity-local.js"
    );
    const extended = await dispatchExtendedDeviceRoute(path, method);
    return extended ?? notImplemented(path.split("?")[0] ?? path);
  }
  return handleCoreRoute(matched.route, method, init, path);
}

/** Test seam — wipe provisional sessions. */
export function resetDeviceIdentitySessionsForTests(): void {
  sessionsByToken.clear();
}

/** Re-export for callers that need the claim host URL without importing claims. */
export function deviceClaimVerifyBase(): string {
  return pagesClaimBase();
}

import { type JsonObject, isString, overlapCast } from "@opensesame/os-domain";
import { afterEach, beforeEach, expect, vi } from "vitest";
import type { createControlPlane } from "../create-app.js";
import { assertionFor } from "./interaction-webauthn-fixture.js";

/**
 * Shared requests for the factor-removal step-up suites (ADR 0146): a
 * signed-in principal, its factors, a removal with or without a proof, and
 * the WebAuthn challenges a proof is made over.
 */

export type Plane = ReturnType<typeof createControlPlane>;

export const DEV = {
  port: 0,
  publicUrl: "http://127.0.0.1:8788",
  issuer: "http://127.0.0.1:8788",
} as const;

/** Mid-step, so a code computed here is the one the service computes. */
export const NOW = Date.UTC(2026, 8, 26, 12, 0, 10);

/** Pin `Date` mid-step for every test in the calling file. */
export function pinClock(): void {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
}

export async function signedIn(cp: Plane) {
  const res = await cp.app.request("/v1/principals/provisional", {
    method: "POST",
  });
  expect(res.status).toBe(201);
  const body: { accessToken: string; principalId: string } = overlapCast(
    await res.json(),
  );
  return body;
}

export function headers(token: string) {
  return {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
}

export async function enrolTotp(cp: Plane, token: string): Promise<string> {
  const res = await cp.app.request("/v1/mfa/totp/enroll", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(200);
  const body: { secret: string } = overlapCast(await res.json());
  return body.secret;
}

export async function factorIds(cp: Plane, token: string): Promise<string[]> {
  const res = await cp.app.request("/v1/mfa/factors", {
    headers: { authorization: `Bearer ${token}` },
  });
  const body: { factors: { id: string }[] } = overlapCast(await res.json());
  return body.factors.map((factor) => factor.id);
}

export function remove(
  cp: Plane,
  token: string,
  id: string,
  proof?: JsonObject,
) {
  return cp.app.request(`/v1/mfa/factors/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: headers(token),
    ...(proof ? { body: JSON.stringify({ proof }) } : {}),
  });
}

/** A challenge minted for removing `factorId`, under `token`'s session. */
export async function removalChallenge(
  cp: Plane,
  token: string,
  factorId: string,
): Promise<string> {
  const res = await cp.app.request("/v1/mfa/passkey/authentication-options", {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify({ purpose: "factor.remove", factorId }),
  });
  expect(res.status).toBe(200);
  const body = overlapCast(await res.json());
  expect(isString(body.challenge)).toBe(true);
  return String(body.challenge);
}

export async function plainChallenge(
  cp: Plane,
  token: string,
): Promise<string> {
  const res = await cp.app.request("/v1/mfa/passkey/authentication-options", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(200);
  return String(overlapCast(await res.json()).challenge);
}

export function passkeyProof(
  challenge: string,
  credentialId: string,
): JsonObject {
  return { kind: "passkey", ...assertionFor(challenge, credentialId) };
}

export async function refusal(res: Response) {
  return { status: res.status, error: overlapCast(await res.json()).error };
}

export async function events(cp: Plane, principalId: string) {
  const all = await cp.ctx.repos.auditEvents.list({ limit: 200 });
  return all.filter(
    (event) =>
      event.principalId === principalId &&
      event.eventType === "mfa.factor.remove",
  );
}

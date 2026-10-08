/** Exactly two authentication-only Identity operations, not an HTTP bypass. */
import { assertAuthenticationSession } from "./decoy-session.js";
import { remoteIdentityApi } from "./device-identity.js";
import { identitySeams } from "./identity.js";
import { localNetworkFetch } from "./local-network-fetch.js";
import {
  type MfaAuthenticationPermit,
  assertMfaAuthenticationPermit,
  validateMfaAuthenticationPermit,
} from "./vault/remote-code-admission.js";

export type MfaAuthenticationRequest =
  | { operation: "send"; channel: "email" | "sms"; to: string }
  | { operation: "verify"; challengeId: string; code: string };

function authenticationPayload(request: MfaAuthenticationRequest) {
  let path: string;
  let body: string;
  if (request.operation === "send") {
    if (
      (request.channel !== "email" && request.channel !== "sms") ||
      !request.to ||
      request.to.length > 320
    )
      throw new Error("Invalid second-factor destination.");
    path = "/v1/mfa/code/send";
    body = JSON.stringify({ channel: request.channel, to: request.to });
  } else {
    if (
      !request.challengeId ||
      request.challengeId.length > 256 ||
      !/^\d{6}$/.test(request.code)
    )
      throw new Error("Invalid second-factor code.");
    path = "/v1/mfa/code/verify";
    body = JSON.stringify({
      challengeId: request.challengeId,
      code: request.code,
    });
  }
  return { path, body };
}

/** Only private fresh-primary admission can supply a permit for these routes. */
export async function identityMfaAuthentication(
  request: MfaAuthenticationRequest,
  permit: MfaAuthenticationPermit,
): Promise<Response> {
  const realm = assertAuthenticationSession();
  if (request.operation !== "send" && request.operation !== "verify")
    throw new Error("Invalid second-factor operation.");
  const challenge =
    request.operation === "verify" ? request.challengeId : undefined;
  await validateMfaAuthenticationPermit(permit, challenge);
  assertMfaAuthenticationPermit(permit, challenge);
  assertAuthenticationSession(realm);
  const base = remoteIdentityApi();
  if (!base) throw new Error("A connected sign-in service is required.");
  const { path, body } = authenticationPayload(request);
  const headers = new Headers({ "content-type": "application/json" });
  // Never return the ambient bearer to the pending application's public getters.
  const session = identitySeams.currentSession();
  if (session && !session.cookieOnly)
    headers.set("authorization", `Bearer ${session.accessToken}`);
  assertAuthenticationSession(realm);
  assertMfaAuthenticationPermit(permit, challenge);
  const response = await localNetworkFetch(`${base}${path}`, {
    method: "POST",
    body,
    headers,
    credentials: session?.adopted ? "omit" : "include",
    timeoutMs: 8000,
  });
  assertAuthenticationSession(realm);
  await validateMfaAuthenticationPermit(permit, challenge);
  assertAuthenticationSession(realm);
  assertMfaAuthenticationPermit(permit, challenge);
  return response;
}

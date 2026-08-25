/**
 * Bring-your-own OIDC provider registration (ADR 0055 / D5).
 *
 * Talks to the Identity API's public `POST /v1/federated/byo-upstreams` — the
 * JSON twin of the hosted login page's BYO form. The heavy lifting (SSRF-fenced
 * discovery, issuer match, RFC 7591 dynamic client registration, abuse budget,
 * idempotency by issuer) all lives server-side; this module only carries the
 * visitor's issuer URL over and the registered record back.
 *
 * A BYO issuer can never email-merge accounts — that separation is a security
 * guarantee of the trust model, and worth saying in the UI.
 */

import {
  type BoundaryValue,
  isJsonObject,
  isString,
  overlapCast,
} from "@opensesame/os-domain";
import { identityBase } from "./identity.js";
import { localNetworkFetch } from "./local-network-fetch.js";

const BYO_FETCH_MS = 15_000;

export type ByoRegistration = {
  id: string;
  issuer: string;
  label: string;
  clientId: string;
  clientAuth: string;
  registrationSource: string;
  /** What the visitor registers at their own IdP when DCR was unavailable. */
  redirectUri: string;
};

export class ByoError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ByoError";
    this.code = code;
  }
}

function isRegistration(value: BoundaryValue): value is ByoRegistration {
  return (
    isJsonObject(value) &&
    isString(value.id) &&
    isString(value.issuer) &&
    isString(value.label) &&
    isString(value.clientId) &&
    isString(value.clientAuth) &&
    isString(value.registrationSource) &&
    isString(value.redirectUri)
  );
}

async function registerByoProviderDefault(input: {
  issuer: string;
  clientId?: string;
  clientSecret?: string;
}): Promise<ByoRegistration> {
  const base = identityBase();
  if (!base) {
    throw new ByoError(
      "no_identity_api",
      "This deployment isn't connected to an identity service yet, so a provider can't be registered.",
    );
  }
  let response: Response;
  try {
    response = await localNetworkFetch(`${base}/v1/federated/byo-upstreams`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "omit",
      body: JSON.stringify({
        issuer: input.issuer,
        ...(input.clientId?.trim() ? { clientId: input.clientId.trim() } : {}),
        ...(input.clientSecret ? { clientSecret: input.clientSecret } : {}),
      }),
      timeoutMs: BYO_FETCH_MS,
    });
  } catch {
    throw new ByoError(
      "identity_unavailable",
      "The identity service couldn't be reached. Check your connection and try again.",
    );
  }
  const body: BoundaryValue = await response.json().catch(() => null);
  if (!response.ok) {
    if (isJsonObject(body) && isString(body.error) && isString(body.message)) {
      throw new ByoError(body.error, body.message);
    }
    throw new ByoError(
      "registration_failed",
      `The identity service refused the registration (${response.status}).`,
    );
  }
  const parsed = overlapCast<BoundaryValue, BoundaryValue>(body);
  if (!isRegistration(parsed)) {
    throw new ByoError(
      "registration_failed",
      "The identity service returned an unusable registration.",
    );
  }
  return parsed;
}

export const byoSeams = {
  registerByoProvider: registerByoProviderDefault,
};

export async function registerByoProvider(input: {
  issuer: string;
  clientId?: string;
  clientSecret?: string;
}): Promise<ByoRegistration> {
  return byoSeams.registerByoProvider(input);
}

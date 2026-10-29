/**
 * Boat agent registration (auth.md): how an agent gets a Boat API token
 * with no pre-provisioned account and no pasted API key.
 *
 * Protocol: https://boat.dev/auth.md — register anonymously (or with the
 * user's email via `service_auth`), hand the person a verification link
 * and a 6-digit code, then poll the token endpoint with the claim grant.
 * This module performs the HTTP steps only; surfacing the claim to a
 * person is the caller's human-intervention channel
 * (`SandboxClaimRequiredError`).
 */

import { z } from "zod";
import { boatClaimUrl, boatOrigin } from "./boat-endpoints.js";

export interface BoatAuthOptions {
  /** Boat origin; must match the host auth.md was fetched from. */
  origin?: string;
  fetchImpl?: typeof fetch;
}

export interface BoatClaimMaterials {
  claimToken: string;
  userCode: string;
  verificationUri: string;
  /** Seconds the user code stays valid. */
  expiresIn: number;
  /** Minimum seconds between claim polls. */
  interval: number;
}

export interface BoatRegistration {
  claimToken: string;
  /** Present for anonymous registration; exchange it for a token. */
  identityAssertion?: string;
  /** Present when the claim ceremony can start immediately. */
  claim?: BoatClaimMaterials;
}

export interface BoatTokenGrant {
  accessToken: string;
  identityAssertion?: string;
}

/** The claim poll says the person has not finished yet. */
export class BoatClaimPendingError extends Error {
  constructor() {
    super("boat: claim is still waiting for the person");
    this.name = "BoatClaimPendingError";
  }
}

const claimBlockSchema = z.object({
  user_code: z.string(),
  verification_uri: z.string(),
  expires_in: z.number(),
  interval: z.number(),
});

const registrationResponseSchema = z.object({
  claim_token: z.string(),
  identity_assertion: z.string().optional(),
  claim: claimBlockSchema.optional(),
});

const claimResponseSchema = claimBlockSchema.extend({
  claim_token: z.string().optional(),
});

const tokenResponseSchema = z.object({
  access_token: z.string().optional(),
  identity_assertion: z.string().optional(),
  error: z.string().optional(),
});

interface IdentityBody {
  type: "anonymous" | "service_auth";
  login_hint?: string;
}

function claimFrom(
  claimToken: string,
  claim: z.infer<typeof claimBlockSchema>,
  origin: string,
): BoatClaimMaterials {
  return {
    claimToken,
    userCode: claim.user_code,
    verificationUri: boatClaimUrl(claim.verification_uri, origin),
    expiresIn: claim.expires_in,
    interval: claim.interval,
  };
}

export class BoatAgentAuth {
  private readonly origin: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: BoatAuthOptions = {}) {
    this.origin = boatOrigin(options.origin ?? "https://boat.dev");
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async postJson(path: string, body: IdentityBody | ClaimBody) {
    const response = await this.fetchImpl(`${this.origin}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      redirect: "error",
    });
    const raw: unknown = await response.json().catch(() => null);
    if (!response.ok)
      throw new Error(
        `boat: registration request failed (HTTP ${response.status})`,
      );
    return raw;
  }

  private async postToken(fields: TokenFields): Promise<BoatTokenGrant> {
    const form = new URLSearchParams(fields);
    const response = await this.fetchImpl(
      `${this.origin}/api/boat/oauth2/token`,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: form.toString(),
        redirect: "error",
      },
    );
    const parsed = tokenResponseSchema.parse(
      await response.json().catch(() => null),
    );
    if (
      parsed.error === "authorization_pending" ||
      parsed.error === "slow_down"
    )
      throw new BoatClaimPendingError();
    if (!response.ok || !parsed.access_token)
      throw new Error(
        `boat: token grant failed (${parsed.error ?? `HTTP ${response.status}`})`,
      );
    const grant: BoatTokenGrant = { accessToken: parsed.access_token };
    if (parsed.identity_assertion)
      grant.identityAssertion = parsed.identity_assertion;
    return grant;
  }

  /**
   * Register this agent. With no email, Boat returns an identity
   * assertion immediately (pre-claim, read-only). With the user's email
   * (`service_auth`), the claim ceremony must finish first.
   */
  async register(email?: string): Promise<BoatRegistration> {
    const body: IdentityBody = email
      ? { type: "service_auth", login_hint: email }
      : { type: "anonymous" };
    const raw = await this.postJson("/api/boat/agent/identity", body);
    const parsed = registrationResponseSchema.parse(raw);
    const registration: BoatRegistration = {
      claimToken: parsed.claim_token,
    };
    if (parsed.identity_assertion)
      registration.identityAssertion = parsed.identity_assertion;
    if (parsed.claim)
      registration.claim = claimFrom(
        parsed.claim_token,
        parsed.claim,
        this.origin,
      );
    return registration;
  }

  /** Start (or restart) the claim ceremony for an anonymous registration. */
  async requestClaim(
    claimToken: string,
    email: string,
  ): Promise<BoatClaimMaterials> {
    const raw = await this.postJson("/api/boat/agent/identity/claim", {
      claim_token: claimToken,
      email,
    });
    const parsed = claimResponseSchema.parse(raw);
    return claimFrom(parsed.claim_token ?? claimToken, parsed, this.origin);
  }

  /** One claim-grant poll. Throws `BoatClaimPendingError` while waiting. */
  async pollClaim(claimToken: string): Promise<BoatTokenGrant> {
    return this.postToken({
      grant_type: "urn:workos:agent-auth:grant-type:claim",
      claim_token: claimToken,
    });
  }

  /** Exchange an identity assertion for an access token (rotates keys). */
  async exchangeAssertion(assertion: string): Promise<BoatTokenGrant> {
    return this.postToken({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
      resource: `${this.origin}/api/v1/`,
    });
  }
}

interface ClaimBody {
  claim_token: string;
  email: string;
}

type TokenFields =
  | { grant_type: string; claim_token: string }
  | { grant_type: string; assertion: string; resource: string };

/** Fresh verified OIDC evidence remains private until its original caller consumes it once. */
import {
  type VerifiedIdTokenClaims,
  verifyBrowserIdTokenClaims,
} from "@opensesame/sdk-browser";
import { decodeJwt } from "jose";

import type { OidcOrganization } from "../../lib/identity-oidc-config.js";
import { assertOidcOrganization } from "../../lib/identity-oidc-config.js";
export type { OidcOrganization } from "../../lib/identity-oidc-config.js";
export { assertOidcOrganization } from "../../lib/identity-oidc-config.js";
export type OidcOwner = Readonly<{
  signal: AbortSignal;
  assertCurrent: () => void;
}>;
export type NativeOidcClaims = Readonly<{
  issuer: string;
  audience: string;
  subject: string;
  organizationId: string;
  authenticatedAt: number;
  validUntil: number;
  name: string;
  email: string;
}>;
const proofBrand = Symbol("verified-native-oidc");
export type NativeOidcProof = Readonly<{ [proofBrand]: true }>;
const pending = new WeakMap<
  NativeOidcProof,
  Readonly<{ claims: NativeOidcClaims; owner: OidcOwner }>
>();
export type VerifyNativeOidcInput = Readonly<{
  token: string;
  issuer: string;
  clientId: string;
  nonce: string;
  jwksUri: string;
  organization: OidcOrganization | null;
  fetchImpl: typeof fetch;
  owner: OidcOwner;
}>;

function lifetime(verified: VerifiedIdTokenClaims) {
  const now = Date.now();
  const authenticatedAt = (verified.auth_time ?? verified.iat) * 1000;
  const validUntil = verified.exp * 1000;
  if (
    verified.sub.length > 2048 ||
    !Number.isSafeInteger(authenticatedAt) ||
    !Number.isSafeInteger(validUntil) ||
    authenticatedAt > now + 5000 ||
    validUntil <= now
  )
    throw new Error("Invalid verified OIDC subject or lifetime");
  return { authenticatedAt, validUntil };
}

export async function verifyNativeOidcProof(
  input: VerifyNativeOidcInput,
): Promise<NativeOidcProof> {
  const { owner, organization } = input;
  owner.assertCurrent();
  if (organization) assertOidcOrganization(organization);
  const verified = await verifyBrowserIdTokenClaims(input);
  owner.assertCurrent();
  // This same immutable token string has already passed mature JOSE signature/nonce/issuer/audience checks.
  const signed = decodeJwt(input.token);
  if (
    organization &&
    (!Object.hasOwn(signed, organization.claim) ||
      signed[organization.claim] !== organization.id)
  )
    throw new Error(
      "Verified OIDC organization does not match this connection",
    );
  const { authenticatedAt, validUntil } = lifetime(verified);
  const claims: NativeOidcClaims = Object.freeze({
    issuer: input.issuer,
    audience: input.clientId,
    subject: verified.sub,
    organizationId: organization?.id ?? "",
    authenticatedAt,
    validUntil,
    name: verified.name?.slice(0, 2048) ?? "",
    email: verified.email?.slice(0, 2048) ?? "",
  });
  const proof: NativeOidcProof = Object.freeze({ [proofBrand]: true });
  pending.set(proof, Object.freeze({ claims, owner }));
  return proof;
}

export function consumeNativeOidcProof(proof: NativeOidcProof) {
  const value = pending.get(proof);
  pending.delete(proof);
  if (!value) throw new Error("Unknown or already consumed OIDC evidence");
  value.owner.assertCurrent();
  if (value.claims.validUntil <= Date.now())
    throw new Error("Verified OIDC evidence expired");
  return value;
}

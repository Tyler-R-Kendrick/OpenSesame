import type { BoatClaimMaterials } from "./boat-auth.js";
import { boatClaimUrl } from "./boat-endpoints.js";
import type {
  BoatProviderOptions,
  BoatProviderState,
} from "./boat-provider.js";
import { SandboxClaimRequiredError } from "./types.js";

type RegistrationBundle = {
  claimToken: string | undefined;
  identityAssertion: string | undefined;
  claimMaterials: BoatClaimMaterials | undefined;
  claimIssuedAt: number | undefined;
};

function selectedCredentials(options: BoatProviderOptions) {
  if (
    options.claimToken !== undefined ||
    options.identityAssertion !== undefined
  )
    return {
      claimToken: options.claimToken,
      identityAssertion: options.identityAssertion,
      explicit: true,
    };
  if (
    options.state?.claimToken !== undefined ||
    options.state?.identityAssertion !== undefined
  )
    return {
      claimToken: options.state?.claimToken,
      identityAssertion: options.state?.identityAssertion,
      explicit: false,
    };
  return {
    claimToken: process.env.BOAT_CLAIM_TOKEN,
    identityAssertion: process.env.BOAT_IDENTITY_ASSERTION,
    explicit: false,
  };
}

/** Keep explicit, stored and environment credentials from different registrations separate. */
export function resolveBoatRegistration(
  options: BoatProviderOptions,
): RegistrationBundle {
  const credentials = selectedCredentials(options);
  const persisted = options.state?.claimMaterials;
  if (persisted && persisted.claimToken !== options.state?.claimToken)
    throw new Error(
      "boat: persisted claim materials do not match the registration",
    );
  const usePersisted =
    !credentials.explicit &&
    persisted !== undefined &&
    persisted.claimToken === credentials.claimToken;
  return {
    claimToken: credentials.claimToken,
    identityAssertion: credentials.identityAssertion,
    claimMaterials: usePersisted ? persisted : undefined,
    claimIssuedAt: usePersisted ? options.state?.claimIssuedAt : undefined,
  };
}

/** Reject expired, clock-invalid or mismatched claim handoffs. */
export function isBoatClaimUsable(
  claim: BoatClaimMaterials,
  token: string | undefined,
  issuedAt: number | undefined,
): boolean {
  if (
    issuedAt === undefined ||
    !Number.isFinite(issuedAt) ||
    !Number.isFinite(claim.expiresIn) ||
    claim.expiresIn <= 0 ||
    claim.expiresIn * 1000 > Number.MAX_SAFE_INTEGER ||
    claim.claimToken !== token
  )
    return false;
  const elapsed = Date.now() - issuedAt;
  return (
    Number.isFinite(elapsed) && elapsed >= 0 && elapsed < claim.expiresIn * 1000
  );
}

/** Surface only an unexpired claim bound to the selected registration. */
export function requireBoatClaim(
  claim: BoatClaimMaterials | undefined,
  token: string | undefined,
  issuedAt: number | undefined,
  origin: string,
): never {
  if (claim && isBoatClaimUsable(claim, token, issuedAt))
    throw new SandboxClaimRequiredError({
      verificationUri: boatClaimUrl(claim.verificationUri, origin),
      userCode: claim.userCode,
    });
  throw new Error(
    "boat: claim link is unavailable or expired; set BOAT_CLAIM_EMAIL to request a fresh claim",
  );
}

export function snapshotBoatRegistration(
  token: string | undefined,
  assertion: string | undefined,
  claim: BoatClaimMaterials | undefined,
  issuedAt: number | undefined,
): BoatProviderState {
  const state: BoatProviderState = {};
  if (token) state.claimToken = token;
  if (assertion) state.identityAssertion = assertion;
  if (claim) state.claimMaterials = claim;
  if (issuedAt !== undefined) state.claimIssuedAt = issuedAt;
  return state;
}

export function boatSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const BOAT_READY_STATES = new Set(["ready", "idle", "running"]);

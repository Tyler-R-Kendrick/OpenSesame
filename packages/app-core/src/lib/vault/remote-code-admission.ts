/** Internal second-factor permits; never registered as agent or RPC capabilities. */
import {
  assertAuthenticationSession,
  freshOwnerAuthenticationTomb,
  freshOwnerAuthenticationVault,
  requiresFreshOwnerAuthentication,
} from "../decoy-session.js";

const permitBrand = Symbol("remote-code-authentication");
export type MfaAuthenticationPermit = Readonly<{ [permitBrand]: true }>;
type Context = {
  tomb: string;
  vaultIdentity: string | null;
  realm: number;
  issued: number;
  challenge: string | null;
  validate: () => Promise<void>;
  assertCurrent: () => void;
};
const permits = new WeakMap<MfaAuthenticationPermit, Context>();

/** Called by the private store's verified primary-key provenance helper. */
export function issueMfaAuthenticationPermit(
  tomb: string,
  realm: number,
  vaultIdentity: string | null,
  validate: () => Promise<void>,
  assertCurrent: () => void,
): MfaAuthenticationPermit {
  assertCurrent();
  assertAuthenticationSession(realm);
  if (
    requiresFreshOwnerAuthentication() &&
    (freshOwnerAuthenticationTomb() !== tomb ||
      freshOwnerAuthenticationVault() !== vaultIdentity)
  )
    throw new Error(
      "Authenticate the original vault before requesting a second factor.",
    );
  const permit = Object.freeze({ [permitBrand]: true as const });
  permits.set(permit, {
    tomb,
    vaultIdentity,
    realm,
    issued: Date.now(),
    challenge: null,
    validate,
    assertCurrent,
  });
  return permit;
}

function context(permit: MfaAuthenticationPermit): Context {
  const value = permits.get(permit);
  if (!value || Date.now() - value.issued > 600_000)
    throw new Error(
      "Start authentication again before requesting a second factor.",
    );
  value.assertCurrent();
  assertAuthenticationSession(value.realm);
  if (
    requiresFreshOwnerAuthentication() &&
    (freshOwnerAuthenticationTomb() !== value.tomb ||
      freshOwnerAuthenticationVault() !== value.vaultIdentity)
  )
    throw new Error(
      "Authenticate the original vault before requesting a second factor.",
    );
  return value;
}

export function assertMfaAuthenticationPermit(
  permit: MfaAuthenticationPermit,
  challenge?: string,
): void {
  const value = context(permit);
  if (challenge !== undefined && value.challenge !== challenge)
    throw new Error(
      "That code does not belong to this authentication attempt.",
    );
}

export function bindMfaAuthenticationChallenge(
  permit: MfaAuthenticationPermit,
  challenge: string,
): void {
  if (!challenge || challenge.length > 256)
    throw new Error("Invalid authentication challenge.");
  context(permit).challenge = challenge;
}

/** Revalidate the captured primary proof without holding its BODY lock over delivery. */
export async function validateMfaAuthenticationPermit(
  permit: MfaAuthenticationPermit,
  challenge?: string,
): Promise<void> {
  assertMfaAuthenticationPermit(permit, challenge);
  await context(permit).validate();
  assertMfaAuthenticationPermit(permit, challenge);
}

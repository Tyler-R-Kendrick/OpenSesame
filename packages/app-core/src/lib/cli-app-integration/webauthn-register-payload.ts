import type { CliAppPasskeyRegistration } from "./webauthn-credential.js";

/** The body the CLI's pairing endpoint takes to register this passkey. */
export type CliAppWebAuthnRegisterPayload = Readonly<{
  vaultSessionRootDigest: string;
  humanProof: string;
  credentialIdB64: string;
  publicKeySpkiB64: string;
  signCount: number;
}>;

export function cliAppWebAuthnRegisterPayload(
  vaultSessionRootDigest: string,
  registration: CliAppPasskeyRegistration,
): CliAppWebAuthnRegisterPayload {
  return {
    vaultSessionRootDigest,
    humanProof: registration.humanProof,
    credentialIdB64: registration.credentialIdB64,
    publicKeySpkiB64: registration.publicKeySpkiB64,
    signCount: registration.signCount,
  };
}

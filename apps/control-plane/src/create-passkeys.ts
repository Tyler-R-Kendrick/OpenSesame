import {
  createMemoryChallengeStore,
  createMemoryPasskeyCredentialStore,
  createPasskeySeam,
  createSimpleWebAuthnVerifyFn,
} from "@opensesame/auth-upstream";
import type { Database } from "@opensesame/database";
import type { ControlPlaneConfig } from "./config.js";
import {
  durablePasskeyChallenges,
  durablePasskeyCredentials,
} from "./repos/durable-passkey-store.js";

export function createPasskeys(config: ControlPlaneConfig, db?: Database) {
  const passkeyChallenges = db
    ? durablePasskeyChallenges(db)
    : createMemoryChallengeStore();
  const credentialStore = db
    ? durablePasskeyCredentials(db)
    : createMemoryPasskeyCredentialStore();
  const rp = {
    rpID: new URL(config.publicUrl).hostname,
    origin: new URL(config.publicUrl).origin,
  };
  const realVerifier = createSimpleWebAuthnVerifyFn(rp, passkeyChallenges);
  return {
    passkeyChallenges,
    passkeys: createPasskeySeam({
      credentialStore,
      verifyAssertion: config.allowDevDefaults
        ? async (assertion) => assertion.signature.byteLength > 0
        : realVerifier,
    }),
    // Never use the development verifier to make an authentication assurance assertion.
    hostAuthorizationPasskeys: createPasskeySeam({
      credentialStore,
      verifyAssertion: realVerifier,
    }),
  };
}

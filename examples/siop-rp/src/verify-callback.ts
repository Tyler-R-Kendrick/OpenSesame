/**
 * RP-side SIOP callback verification — always via {@link verifySelfIssuedIdToken}.
 * Never decode a JWT for trust; cryptographic checks live in @opensesame/siop-v2.
 */
import {
  type VerifiedSelfIssuedIdToken,
  verifySelfIssuedIdToken,
} from "@opensesame/siop-v2";
import { type SiopRpConfig, pagesSiopIssuerProfile } from "./config.js";
import type { NonceStore } from "./nonce-store.js";

export type VerifySiopCallbackInput = {
  idToken: string;
  state: string;
  config: SiopRpConfig;
  store: NonceStore;
  nowMs?: number;
  nowSeconds?: number;
};

export type VerifySiopCallbackResult = {
  verified: VerifiedSelfIssuedIdToken;
  pendingNonce: string;
};

export async function verifySiopCallback(
  input: VerifySiopCallbackInput,
): Promise<VerifySiopCallbackResult> {
  const nowMs = input.nowMs ?? Date.now();
  const pending = input.store.claim(input.state, nowMs);
  try {
    const verifyInput = {
      idToken: input.idToken,
      expectedAudience: input.config.clientId,
      expectedNonce: pending.nonce,
      profile: pagesSiopIssuerProfile(input.config.pagesBase),
    };
    const verified = await verifySelfIssuedIdToken(
      input.nowSeconds === undefined
        ? verifyInput
        : { ...verifyInput, nowSeconds: input.nowSeconds },
    );
    input.store.finish(input.state, nowMs);
    return { verified, pendingNonce: pending.nonce };
  } catch (error) {
    input.store.restore(input.state, pending);
    throw error;
  }
}

export { NonceStoreError } from "./nonce-store.js";

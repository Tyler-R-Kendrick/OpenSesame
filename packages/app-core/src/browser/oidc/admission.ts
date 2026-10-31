/** Only genuine one-use OIDC evidence reaches the shared original local vault admission path. */
import type { NativeFederationIdentity } from "../../lib/federation-native-session.js";
import {
  type NativeIdentityAdmissionRuntime,
  createNativeIdentityAdmissionRuntime,
} from "../../lib/native-identity-admission.js";
import {
  type NativeOidcClaims,
  type NativeOidcProof,
  consumeNativeOidcProof,
} from "./claims.js";
export type NativeOidcAdmissionRuntime = NativeIdentityAdmissionRuntime<
  NativeOidcProof,
  NativeOidcClaims
>;
export function createNativeOidcAdmissionRuntime(): NativeOidcAdmissionRuntime {
  return createNativeIdentityAdmissionRuntime({
    consume(proof: NativeOidcProof) {
      const verified = consumeNativeOidcProof(proof);
      return {
        claims: verified.claims,
        assertCurrent: () => verified.owner.assertCurrent(),
        release: () => undefined,
      };
    },
    project: async (
      claims: NativeOidcClaims,
      target,
    ): Promise<NativeFederationIdentity> => {
      return Object.freeze({
        assertionFormat: "native-oidc",
        issuer: claims.issuer,
        audience: claims.audience,
        upstreamId: `identity:${target.connectionId}`,
        pairwiseSub: claims.subject,
        idToken: "",
        jwksUri: "",
        expiresAt: claims.validUntil,
        name: claims.name || target.label,
        email: claims.email || undefined,
      });
    },
  });
}

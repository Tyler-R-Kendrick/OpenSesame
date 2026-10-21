/** Genuine SAML evidence shares the original local vault admission lifecycle. */
import type { NativeFederationIdentity } from "../../lib/federation-native-session.js";
import {
  type NativeIdentityAdmissionRuntime,
  type NativeIdentityAdmissionTarget,
  createNativeIdentityAdmissionRuntime,
} from "../../lib/native-identity-admission.js";
import type { SamlProtocolClaims } from "./assertion.js";
import {
  type NativeSamlSignInProof,
  consumeNativeSamlSignIn,
} from "./sign-in.js";
export type NativeSamlAdmissionTarget =
  NativeIdentityAdmissionTarget<SamlProtocolClaims>;
export type NativeSamlAdmissionRuntime = NativeIdentityAdmissionRuntime<
  NativeSamlSignInProof,
  SamlProtocolClaims
>;
async function subject(claims: SamlProtocolClaims): Promise<string> {
  const data = new TextEncoder().encode(
    JSON.stringify([
      "OpenSesame native SAML subject v1",
      location.origin,
      claims.issuer,
      claims.audience,
      claims.nameIdFormat,
      claims.nameQualifier,
      claims.spNameQualifier,
      claims.subject,
    ]),
  );
  const digest = await crypto.subtle.digest("SHA-256", data);
  return `saml:${btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")}`;
}
export function createNativeSamlAdmissionRuntime(): NativeSamlAdmissionRuntime {
  return createNativeIdentityAdmissionRuntime({
    consume: consumeNativeSamlSignIn,
    project: async (
      claims: SamlProtocolClaims,
      target,
    ): Promise<NativeFederationIdentity> =>
      Object.freeze({
        assertionFormat: "saml",
        issuer: claims.issuer,
        audience: claims.audience,
        upstreamId: `identity:${target.connectionId}`,
        pairwiseSub: await subject(claims),
        idToken: "",
        jwksUri: "",
        expiresAt: claims.validUntil,
        name: target.label,
      }),
  });
}

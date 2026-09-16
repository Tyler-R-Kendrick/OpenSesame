import {
  ecP256JwkThumbprint,
  parseFragmentResponse,
  verifySelfIssuedIdToken,
} from "@opensesame/siop-v2";

export type SiopRedirectExpectation = {
  issuer: string;
  clientId: string;
  nonce: string;
};

export async function verifySiopRedirect(
  redirectUrl: string,
  expected: SiopRedirectExpectation,
) {
  const parsed = parseFragmentResponse(redirectUrl);
  if (parsed.kind !== "success") {
    throw new Error(`Expected SIOP success fragment, got ${parsed.kind}`);
  }
  const verified = await verifySelfIssuedIdToken({
    idToken: parsed.idToken,
    profile: { kind: "dynamic", issuer: expected.issuer },
    expectedAudience: expected.clientId,
    expectedNonce: expected.nonce,
  });
  const thumbprint = await ecP256JwkThumbprint(verified.subJwk);
  if (verified.sub !== thumbprint) {
    throw new Error("sub does not match JWK thumbprint");
  }
  if (!verified.iAmSiop) {
    throw new Error("missing i_am_siop claim");
  }
  return verified;
}

export function parseSiopDenyRedirect(redirectUrl: string) {
  const parsed = parseFragmentResponse(redirectUrl);
  if (parsed.kind !== "error") {
    throw new Error(`Expected SIOP error fragment, got ${parsed.kind}`);
  }
  return parsed;
}

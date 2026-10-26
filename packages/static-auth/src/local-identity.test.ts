import { expect, it } from "vitest";
import { verifiedIdentity } from "./local-identity.js";
import type { LocalAuthorizationRequest } from "./local-protocol.js";

const origin = "https://identity.example.test";
const canonical = "local_00000000-0000-4000-8000-000000000002";
const subject = "64845976-7fe8-4d5e-9e1a-7fbeacb94d8b";
const request: LocalAuthorizationRequest = {
  applicationId: "local_00000000-0000-4000-8000-000000000001",
  redirectUri: "https://rp.example.test/callback",
  scopes: ["openid"],
  state: "state",
  nonce: "nonce",
  codeChallenge: "challenge",
  codeChallengeMethod: "S256",
};
const identity = {
  type: "identity",
  issuer: origin,
  audience: request.applicationId,
  nonce: request.nonce,
  scope: "openid",
  sub: subject,
  authTime: "1000",
  expiresAt: "61000",
};

it.each([false, true])(
  "accepts an opaque pairwise subject (agent: %s)",
  (agent) => {
    const authorization = agent
      ? { ...request, agent: { principalId: canonical, keyId: "key" } }
      : request;
    expect(
      verifiedIdentity(identity, authorization, origin, "openid", 2000).subject,
    ).toBe(subject);
  },
);

it.each([
  canonical,
  "",
  "not-a-subject",
  "64845976-7fe8-4d5e-0e1a-7fbeacb94d8b",
])("rejects canonical or malformed downstream subjects %s", (sub) => {
  expect(() =>
    verifiedIdentity({ ...identity, sub }, request, origin, "openid", 2000),
  ).toThrow("invalid_identity");
});

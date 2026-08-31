import { describe, expect, it } from "vitest";
import {
  credentialConfiguration,
  credentialConfigurationIds,
  refusalOf,
} from "./__fixtures__/harness.js";
import type { Openid4vciErrorCode } from "./errors.js";
import {
  CREDENTIAL_FORMAT,
  type IssuerMetadataConfig,
  buildIssuerMetadata,
  issuerMetadataUrl,
} from "./metadata.js";

const ISSUER = "https://issuer.example.test";

const CONFIG: IssuerMetadataConfig = {
  credentialIssuer: ISSUER,
  credentialEndpoint: `${ISSUER}/credential`,
  nonceEndpoint: `${ISSUER}/nonce`,
  credentialConfigurationId: "opensesame-holder-binding",
  vct: "https://credentials.example.test/opensesame-holder-binding/v1",
  credentialSigningAlgorithm: "ES256",
  proofSigningAlgorithms: ["ES256", "EdDSA"],
};

function expectRefusal(run: () => void, code: Openid4vciErrorCode): void {
  expect(refusalOf(run).code).toBe(code);
}

describe("buildIssuerMetadata", () => {
  it("publishes exactly one credential configuration in dc+sd-jwt", () => {
    const metadata = buildIssuerMetadata(CONFIG);
    expect(metadata.credential_issuer).toBe(ISSUER);
    expect(metadata.credential_endpoint).toBe(`${ISSUER}/credential`);
    expect(metadata.nonce_endpoint).toBe(`${ISSUER}/nonce`);

    expect(credentialConfigurationIds(metadata)).toEqual([
      "opensesame-holder-binding",
    ]);
    const entry = credentialConfiguration(
      metadata,
      "opensesame-holder-binding",
    );
    expect(entry.format).toBe(CREDENTIAL_FORMAT);
    expect(entry.vct).toBe(CONFIG.vct);
    expect(entry.cryptographic_binding_methods_supported).toEqual(["jwk"]);
    expect(entry.credential_signing_alg_values_supported).toEqual(["ES256"]);
    expect(entry.proof_types_supported).toEqual({
      jwt: { proof_signing_alg_values_supported: ["ES256", "EdDSA"] },
    });
  });

  it("advertises no scope, because the credential is not an authorization", () => {
    const entry = credentialConfiguration(
      buildIssuerMetadata(CONFIG),
      "opensesame-holder-binding",
    );
    expect(Object.hasOwn(entry, "scope")).toBe(false);
  });

  it("always publishes a nonce endpoint, so proofs can never omit a nonce", () => {
    expect(buildIssuerMetadata(CONFIG).nonce_endpoint).toBeTypeOf("string");
  });

  it("omits the endpoints for everything it does not implement", () => {
    const metadata = buildIssuerMetadata(CONFIG);
    for (const absent of [
      "deferred_credential_endpoint",
      "notification_endpoint",
      "batch_credential_issuance",
      "credential_response_encryption",
      "credential_request_encryption",
    ]) {
      expect(Object.hasOwn(metadata, absent)).toBe(false);
    }
  });

  it.each([
    ["credentialIssuer", { credentialIssuer: "" }],
    ["credentialEndpoint", { credentialEndpoint: "" }],
    ["nonceEndpoint", { nonceEndpoint: "" }],
    ["credentialConfigurationId", { credentialConfigurationId: "" }],
    ["vct", { vct: "" }],
  ] as const)("refuses partial config: %s", (_field, missing) => {
    expectRefusal(
      () => buildIssuerMetadata({ ...CONFIG, ...missing }),
      "invalid_issuer_configuration",
    );
  });

  it("refuses an empty proof algorithm list", () => {
    expectRefusal(
      () => buildIssuerMetadata({ ...CONFIG, proofSigningAlgorithms: [] }),
      "invalid_issuer_configuration",
    );
  });

  it("refuses an algorithm outside the allow-list", () => {
    // The type forbids `RS256`, which is the point — the check exists for the
    // deployment that reaches this function from untyped configuration.
    // SAFETY: deliberately asserting a value the runtime contract rejects.
    const outsideTheAllowList = "RS256" as "ES256";
    expectRefusal(
      () =>
        buildIssuerMetadata({
          ...CONFIG,
          proofSigningAlgorithms: [outsideTheAllowList],
        }),
      "invalid_issuer_configuration",
    );
  });

  it("refuses cleartext endpoints, in development as much as anywhere", () => {
    expectRefusal(
      () =>
        buildIssuerMetadata({
          ...CONFIG,
          credentialIssuer: "http://localhost:8787",
          credentialEndpoint: "http://localhost:8787/credential",
          nonceEndpoint: "http://localhost:8787/nonce",
        }),
      "invalid_issuer_configuration",
    );
  });

  it("refuses an endpoint on a different origin than the issuer", () => {
    expectRefusal(
      () =>
        buildIssuerMetadata({
          ...CONFIG,
          nonceEndpoint: "https://elsewhere.example.test/nonce",
        }),
      "invalid_issuer_configuration",
    );
  });

  it("refuses an issuer identifier that is not already canonical", () => {
    for (const identifier of [
      `${ISSUER}/?tenant=a`,
      `${ISSUER}/#fragment`,
      `${ISSUER}/tenant/`,
    ]) {
      expectRefusal(
        () => buildIssuerMetadata({ ...CONFIG, credentialIssuer: identifier }),
        "invalid_issuer_configuration",
      );
    }
  });

  it("refuses an empty authorization_servers array rather than emitting one", () => {
    expectRefusal(
      () => buildIssuerMetadata({ ...CONFIG, authorizationServers: [] }),
      "invalid_issuer_configuration",
    );
  });
});

describe("issuerMetadataUrl", () => {
  it("inserts the well-known path between host and path", () => {
    expect(issuerMetadataUrl("https://issuer.example.test")).toBe(
      "https://issuer.example.test/.well-known/openid-credential-issuer",
    );
    expect(issuerMetadataUrl("https://issuer.example.test/tenant")).toBe(
      "https://issuer.example.test/.well-known/openid-credential-issuer/tenant",
    );
  });
});

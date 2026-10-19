import { expect, it } from "vitest";
import { identityConnectionDraft } from "./identity-connections-presets.js";
import {
  IdentityConnectionDraftSchema,
  publicIdentityDraft,
} from "./identity-connections-schema.js";
import {
  SAML_PERSISTENT_NAME_ID,
  nativeSamlConfigurationProblems,
  samlEntityIdentifier,
  samlMetadataEndpoint,
} from "./identity-saml-config.js";

function draft() {
  return {
    ...identityConnectionDraft("byo-identity"),
    protocol: "saml" as const,
    clientId: "urn:example:sp",
    samlEntityId: "http://idp.example.test/adfs/services/trust",
    samlMetadataUrl:
      "https://idp.example.test/federationmetadata?tenant=example",
  };
}
it("existing saved configurations get the same SAML defaults as BYO/provider presets", () => {
  const initial = draft();
  const legacy = { ...initial };
  Reflect.deleteProperty(legacy, "samlNameIdFormat");
  Reflect.deleteProperty(legacy, "samlAuthnContext");
  Reflect.deleteProperty(legacy, "samlForceAuthentication");
  Reflect.deleteProperty(legacy, "samlSigningPrivateKeyPkcs8");
  Reflect.deleteProperty(legacy, "samlSigningCertificate");
  const loaded = IdentityConnectionDraftSchema.parse(legacy);
  expect(loaded.samlNameIdFormat).toBe(SAML_PERSISTENT_NAME_ID);
  expect(loaded.samlAuthnContext).toBe("");
  expect(loaded.samlForceAuthentication).toBe("false");
  expect(loaded.samlSigningPrivateKeyPkcs8).toBe("");
  expect(loaded.samlSigningCertificate).toBe("");
});
it("accepts legitimate HTTP/URN SAML entity identifiers while requiring secure metadata transport", () => {
  expect(nativeSamlConfigurationProblems(draft())).toEqual([]);
  expect(samlEntityIdentifier("urn:example:sp")).toBe(true);
  expect(samlEntityIdentifier("http://idp.example.test/entity")).toBe(true);
  expect(samlMetadataEndpoint("http://idp.example.test/metadata")).toBe(false);
});
it("allows exact custom NameID/context URIs and a complete optional operator signing pair", () => {
  expect(
    nativeSamlConfigurationProblems({
      ...draft(),
      samlNameIdFormat: "urn:example:name",
      samlAuthnContext: "urn:example:strong",
      samlForceAuthentication: "true",
      samlSigningPrivateKeyPkcs8:
        "synthetic configuration placeholder; actual crypto is verified by request test",
      samlSigningCertificate: "synthetic certificate placeholder",
    }),
  ).toEqual([]);
});
it("public form projections keep the SP certificate visible and the private signing key write-only", () => {
  const loaded = publicIdentityDraft({
    ...draft(),
    samlSigningCertificate: "public fixture certificate",
    samlSigningPrivateKeyPkcs8: "private fixture placeholder",
  });
  expect(loaded.samlSigningPrivateKeyPkcs8).toBe("");
  expect(loaded.samlSigningCertificate).toBe("public fixture certificate");
});
it.each([
  ["missing SP entity", { clientId: "" }],
  ["missing IdP entity", { samlEntityId: "" }],
  ["relative entity", { samlEntityId: "relative-entity" }],
  ["executable entity", { samlEntityId: "javascript:alert(1)" }],
  [
    "metadata credentials",
    { samlMetadataUrl: "https://user:pass@idp.example.test/metadata" },
  ],
  [
    "metadata fragment",
    { samlMetadataUrl: "https://idp.example.test/metadata#fragment" },
  ],
  ["metadata missing", { samlMetadataUrl: "" }],
  [
    "metadata control",
    { samlMetadataUrl: "https://idp.example.test/\nmetadata" },
  ],
  ["ambiguous metadata sources", { samlMetadataXml: "<metadata/>" }],
  ["invalid NameID", { samlNameIdFormat: "" }],
  ["invalid exact authn context", { samlAuthnContext: "not a URI" }],
  ["incomplete signing key", { samlSigningPrivateKeyPkcs8: "placeholder" }],
  ["incomplete signing cert", { samlSigningCertificate: "placeholder" }],
] as const)("requires actionable configuration for %s", (_name, changed) => {
  expect(
    nativeSamlConfigurationProblems({ ...draft(), ...changed }).length,
  ).toBeGreaterThan(0);
});
it("accepts inline metadata without any app service and explicit local development metadata endpoints", () => {
  expect(
    nativeSamlConfigurationProblems({
      ...draft(),
      samlMetadataUrl: "",
      samlMetadataXml: "<metadata/>",
    }),
  ).toEqual([]);
  expect(samlMetadataEndpoint("http://127.0.0.1:12345/metadata")).toBe(true);
});

import { beforeEach, expect, it } from "vitest";
import { configureHost } from "../host.js";
import { createTestHost } from "../test-host.js";
import { readDeviceRows } from "./device-connector-records.js";
import { identityConnectionDraft } from "./identity-connections-presets.js";
import {
  assertIdentityConnectionUnchanged,
  getIdentityConnectionRuntime,
  identityConnectionRevision,
  readIdentityConnection,
  resolveIdentityConnectionSecrets,
  writeIdentityConnection,
} from "./identity-connections-store.js";
import { kvForgetAll } from "./kv.js";

beforeEach(() => {
  configureHost(createTestHost());
  kvForgetAll();
});
function saml() {
  return {
    ...identityConnectionDraft("byo-identity"),
    protocol: "saml" as const,
    clientId: "urn:fixture:sp",
    samlEntityId: "urn:fixture:idp",
    samlMetadataXml: "<public-metadata-fixture/>",
    samlSigningCertificate: "public-certificate-fixture",
    samlSigningPrivateKeyPkcs8: "write-only-private-config-fixture",
  };
}
it("assigns a fresh public revision even when an operator resaves identical configuration", async () => {
  const draft = saml();
  const first = await writeIdentityConnection(draft);
  const original = identityConnectionRevision(first.connectionId);
  expect(original).toMatch(/^[a-f0-9]{48}$/);
  await writeIdentityConnection(draft, first.connectionId);
  expect(identityConnectionRevision(first.connectionId)).not.toBe(original);
  expect(readDeviceRows()[0].fields.identity_configuration).not.toContain(
    draft.samlSigningPrivateKeyPkcs8,
  );
  expect(
    readIdentityConnection(first.connectionId)?.samlSigningPrivateKeyPkcs8,
  ).toBe("");
});
it("an unchanged credential target retains write-only metadata and signing key", async () => {
  const draft = saml();
  const saved = await writeIdentityConnection(draft);
  const publicDraft = readIdentityConnection(saved.connectionId);
  if (!publicDraft) throw new Error("Expected saved public configuration");
  const merged = resolveIdentityConnectionSecrets(
    publicDraft,
    saved.connectionId,
  );
  expect(merged.samlMetadataXml).toBe(draft.samlMetadataXml);
  expect(merged.samlSigningPrivateKeyPkcs8).toBe(
    draft.samlSigningPrivateKeyPkcs8,
  );
});
it("switching inline metadata to a URL cannot silently retain old private metadata", async () => {
  const saved = await writeIdentityConnection(saml());
  const publicDraft = readIdentityConnection(saved.connectionId);
  if (!publicDraft) throw new Error("Expected saved public configuration");
  const merged = resolveIdentityConnectionSecrets(
    { ...publicDraft, samlMetadataUrl: "https://idp.example/metadata" },
    saved.connectionId,
  );
  expect(merged.samlMetadataXml).toBe("");
  expect(merged.samlSigningPrivateKeyPkcs8).toBe("");
});
it("replacing a public SP signing certificate cannot silently spend the old private key", async () => {
  const saved = await writeIdentityConnection(saml());
  const publicDraft = readIdentityConnection(saved.connectionId);
  if (!publicDraft) throw new Error("Expected saved public configuration");
  const merged = resolveIdentityConnectionSecrets(
    { ...publicDraft, samlSigningCertificate: "different-certificate" },
    saved.connectionId,
  );
  expect(merged.samlSigningPrivateKeyPkcs8).toBe("");
});
it.each(["samlMetadataXml", "samlSigningPrivateKeyPkcs8"] as const)(
  "an awaited response cannot authenticate after the write-only %s changes",
  async (field) => {
    const draft = saml();
    const saved = await writeIdentityConnection(draft);
    const original = getIdentityConnectionRuntime(saved.connectionId);
    if (!original) throw new Error("Expected saved runtime configuration");
    await expect(
      assertIdentityConnectionUnchanged(saved.connectionId, original),
    ).resolves.toBeUndefined();
    await writeIdentityConnection(
      { ...draft, [field]: "changed-write-only-value" },
      saved.connectionId,
    );
    await expect(
      assertIdentityConnectionUnchanged(saved.connectionId, original),
    ).rejects.toThrow("changed during sign-in");
  },
);
it("missing saved identity has no configuration revision", () => {
  expect(identityConnectionRevision("missing")).toBeNull();
});

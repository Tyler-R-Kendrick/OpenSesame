/** trusted issuer port fixture; no issuer-server auth claim. */
import { afterEach, expect, it } from "vitest";
import { kvDelete, kvGet } from "../kv.js";
import {
  PASSWORD,
  createRetiredCredentialFixture,
} from "../retired-credentials/test-support.js";
import type { CredentialCanaryIssuerResponse } from "./issuer-response.js";
import { currentCredentialObservationIdentity } from "./owner.js";
import { controlledIdentifierDigest } from "./protocol.js";
import {
  configureCredentialCanaryIssuer,
  listControlledCanaries,
  retireIssuedIdentifier,
} from "./registry.js";
import { canaryRegistryKey } from "./storage.js";
let restore = () => {};
afterEach(() => {
  restore();
  kvDelete(canaryRegistryKey("personal"));
});

it("authenticated issuer responses with invalid production lineage never persist a registry, while the exact valid record does", async () => {
  const f = await createRetiredCredentialFixture();
  restore = f.restore;
  kvDelete(canaryRegistryKey("personal"));
  const vaultIdentity = await currentCredentialObservationIdentity("personal");
  const context = {
    vaultIdentity,
    kind: "connection_ref" as const,
    generation: 7,
  };
  const presentedId = "A".repeat(43);
  const timestamp = new Date().toISOString();
  const artifact = {
    id: crypto.randomUUID(),
    context,
    digestB64: await controlledIdentifierDigest(context, presentedId),
    state: "retired" as const,
    createdAt: timestamp,
    retiredAt: timestamp,
  };
  const valid: CredentialCanaryIssuerResponse = {
    kind: "authenticated_retired_artifact",
    binding: { tomb: "personal", vaultIdentity },
    artifact,
  };
  const invalid: CredentialCanaryIssuerResponse[] = [
    {
      kind: "presented_identifier",
      presentedId,
      context: { ...context, kind: "mcp_configuration" },
    },
    {
      ...valid,
      artifact: {
        ...artifact,
        context: { ...context, kind: "mcp_configuration" },
      },
    },
    { ...valid, artifact: { ...artifact, digestB64: "A".repeat(43) } },
    {
      ...valid,
      artifact: {
        ...artifact,
        retiredAt: new Date(Date.parse(timestamp) - 1).toISOString(),
      },
    },
    { ...valid, artifact: { ...artifact, id: crypto.randomUUID() } },
  ];
  const owner = {
    tomb: "personal",
    currentPassword: PASSWORD,
    issuerRecordRef: artifact.id,
  };
  const before = kvGet(canaryRegistryKey("personal"));
  for (const response of invalid) {
    let dispatched = 0;
    configureCredentialCanaryIssuer({
      async resolveRetiredIdentifier(ref, tomb) {
        expect(ref).toBe(artifact.id);
        expect(tomb).toBe("personal");
        dispatched += 1;
        return response;
      },
    });
    await expect(retireIssuedIdentifier(owner)).rejects.toThrow();
    expect(dispatched).toBe(1);
    expect(kvGet(canaryRegistryKey("personal"))).toBe(before);
  }
  configureCredentialCanaryIssuer({
    async resolveRetiredIdentifier() {
      return valid;
    },
  });
  await retireIssuedIdentifier(owner);
  const { digestB64, ...publicArtifact } = artifact;
  expect((await listControlledCanaries("personal")).artifacts).toEqual([
    publicArtifact,
  ]);
  expect(kvGet(canaryRegistryKey("personal"))).toContain(digestB64);
  expect(kvGet(canaryRegistryKey("personal"))).not.toContain(presentedId);
});

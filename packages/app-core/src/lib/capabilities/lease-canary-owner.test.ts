import type { PlanIdentity } from "@opensesame/capability-composition";
import { expect, it } from "vitest";
import { currentCredentialObservationIdentity } from "../credential-canaries/owner.js";
import {
  configureCredentialCanaryIssuer,
  listControlledCanaries,
  retireIssuedIdentifier,
} from "../credential-canaries/registry.js";
import { canaryRegistryKey } from "../credential-canaries/storage.js";
import { kvDelete } from "../kv.js";
import {
  PASSWORD,
  createRetiredCredentialFixture,
} from "../retired-credentials/test-support.js";
import {
  configureLeaseIssuerScope,
  issuedLeaseReference,
  listRetiredLeaseIdentifiers,
  resolveIssuedLeaseReference,
  resolveRetiredLeaseIdentifier,
} from "./lease-canary-issuer.js";
import { mintLease } from "./lease.js";
const identity: PlanIdentity = {
  instanceId: "instance",
  installationId: "installation",
  vaultId: "personal",
  distributionId: "distribution",
  policyRevision: "r1",
  selectionRevision: "s1",
  planDigest: `sha256:${"0".repeat(64)}`,
};
it("fresh actual owner retires an actually accepted lease alias, whose replay records and always denies", async () => {
  const fixture = await createRetiredCredentialFixture();
  kvDelete(canaryRegistryKey("personal"));
  const vaultIdentity = await currentCredentialObservationIdentity("personal");
  const stop = configureLeaseIssuerScope(() => ({
    tomb: "personal",
    vaultIdentity,
  }));
  configureCredentialCanaryIssuer({
    resolveRetiredIdentifier: resolveRetiredLeaseIdentifier,
  });
  try {
    const minted = mintLease(identity, 77);
    const alias = issuedLeaseReference(minted.lease);
    expect(await resolveIssuedLeaseReference(alias, 77)).toBe(minted.lease);
    minted.abort("actual-owner-revocation");
    const record = listRetiredLeaseIdentifiers("personal").find(
      (r) => r.context.generation === 77,
    );
    if (!record) throw new Error("missing actual revoked issuer record");
    await expect(
      retireIssuedIdentifier({
        tomb: "personal",
        currentPassword: "wrong-owner-password",
        issuerRecordRef: record.issuerRecordRef,
      }),
    ).rejects.toThrow();
    await retireIssuedIdentifier({
      tomb: "personal",
      currentPassword: PASSWORD,
      issuerRecordRef: record.issuerRecordRef,
    });
    await expect(resolveIssuedLeaseReference(alias, 77)).rejects.toThrow(
      "retired",
    );
    const status = await listControlledCanaries("personal");
    expect(status.artifacts).toHaveLength(1);
    expect(status.artifacts[0]?.state).toBe("retired");
    expect(status.events).toHaveLength(1);
    expect(status.events[0]?.phase).toBe("retired_generation_observed");
    await expect(
      resolveIssuedLeaseReference("oslease:v1:forged", 77),
    ).rejects.toThrow();
    expect((await listControlledCanaries("personal")).events).toHaveLength(1);
  } finally {
    stop();
    kvDelete(canaryRegistryKey("personal"));
    fixture.restore();
  }
});

it("an old alias cannot reenter a fresh real session after actual synthetic lock and owner reauthentication", async () => {
  const fixture = await createRetiredCredentialFixture();
  kvDelete(canaryRegistryKey("personal"));
  const vaultIdentity = await currentCredentialObservationIdentity("personal");
  const stop = configureLeaseIssuerScope(() => ({
    tomb: "personal",
    vaultIdentity,
  }));
  configureCredentialCanaryIssuer({
    resolveRetiredIdentifier: resolveRetiredLeaseIdentifier,
  });
  try {
    const minted = mintLease(identity, 78);
    const alias = issuedLeaseReference(minted.lease);
    expect(await resolveIssuedLeaseReference(alias, 78)).toBe(minted.lease);
    fixture.store.lock();
    await fixture.store.createGuest({ decoy: true, resume: false });
    fixture.store.lock();
    await expect(resolveIssuedLeaseReference(alias, 78)).rejects.toThrow();
    await fixture.store.unlock(PASSWORD);
    // This deliberately held lease has no composition watcher to abort it.
    // The original realm admission must still be gone after fresh owner proof.
    expect(minted.lease.signal.aborted).toBe(false);
    await expect(resolveIssuedLeaseReference(alias, 78)).rejects.toThrow();
    const record = listRetiredLeaseIdentifiers("personal").find(
      (r) => r.context.generation === 78,
    );
    if (!record) throw new Error("missing retired realm issuer record");
    await retireIssuedIdentifier({
      tomb: "personal",
      currentPassword: PASSWORD,
      issuerRecordRef: record.issuerRecordRef,
    });
    await expect(resolveIssuedLeaseReference(alias, 78)).rejects.toThrow(
      "retired",
    );
    expect((await listControlledCanaries("personal")).events[0]?.phase).toBe(
      "retired_generation_observed",
    );
  } finally {
    stop();
    kvDelete(canaryRegistryKey("personal"));
    fixture.restore();
  }
});

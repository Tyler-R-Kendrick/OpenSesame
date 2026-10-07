import type { PlanIdentity } from "@opensesame/capability-composition";
import { expect, it } from "vitest";
import { configureHost, host } from "../../host.js";
import { createTestHost } from "../../test-host.js";
import { webLocksDouble } from "../__tests__/web-locks-double.js";
import { currentCredentialObservationIdentity } from "../credential-canaries/owner.js";
import { enrollRetiredCredential } from "../retired-credentials/index.js";
import { flushRetiredCredentialTelemetry } from "../retired-credentials/telemetry-queue.js";
import { unlockWithRetiredCredentialGate } from "../retired-credentials/unlock.js";
import { vaultStore } from "../vault/store.js";
import {
  configureLeaseIssuerScope,
  issuedLeaseReference,
  resolveIssuedLeaseReference,
} from "./lease-canary-issuer.js";
import {
  type MintedLease,
  deriveLease,
  leaseIsCurrent,
  mintLease,
} from "./lease.js";

it("does not let copied, derived or old-generation leases regain real authority after genuine retired owner routing", async () => {
  const originalHost = host();
  let stop = () => {};
  let parent: MintedLease | undefined;
  let ownerCreated = false;
  configureHost(createTestHost({ locks: webLocksDouble() }));
  const password = "lease-current-owner-proof";
  const retired = "lease-retired-owner-proof";
  try {
    await vaultStore.create(password);
    ownerCreated = true;
    await vaultStore.flushPendingWrites();
    const vaultIdentity =
      await currentCredentialObservationIdentity("personal");
    stop = configureLeaseIssuerScope(() => ({
      tomb: "personal",
      vaultIdentity,
    }));
    const identity: PlanIdentity = {
      instanceId: "lease-owner",
      installationId: "lease-installation",
      vaultId: "personal",
      distributionId: "lease-distribution",
      policyRevision: "r1",
      selectionRevision: "s1",
      planDigest: `sha256:${"0".repeat(64)}`,
    };
    parent = mintLease(identity, 4);
    const originalLease = parent.lease;
    const child = deriveLease(parent.lease);
    const sibling = deriveLease(parent.lease);
    const alias = issuedLeaseReference(parent.lease);
    expect(await resolveIssuedLeaseReference(alias, 4)).toBe(parent.lease);
    await expect(resolveIssuedLeaseReference(alias, 5)).rejects.toThrow();
    expect(leaseIsCurrent({ ...parent.lease }, 4)).toBe(false);
    expect(deriveLease({ ...parent.lease }).lease.signal.aborted).toBe(true);
    child.abort("failed-child-activation");
    expect(leaseIsCurrent(sibling.lease, 4)).toBe(true);
    expect(leaseIsCurrent(parent.lease, 4)).toBe(true);
    await enrollRetiredCredential({
      tomb: "personal",
      currentPassword: password,
      retiredPassword: retired,
      response: "synthetic_decoy",
      acknowledgePasswordVerifierRisk: true,
    });
    vaultStore.lock();
    await unlockWithRetiredCredentialGate(vaultStore, retired);
    await expect(resolveIssuedLeaseReference(alias, 4)).rejects.toThrow();
    expect(() => issuedLeaseReference(originalLease)).toThrow();
    vaultStore.lock();
    await expect(resolveIssuedLeaseReference(alias, 4)).rejects.toThrow();
    parent.abort("withdraw-original-production-authority");
    expect(sibling.lease.signal.aborted).toBe(true);
    await flushRetiredCredentialTelemetry();
    await vaultStore.unlock(password);
    await expect(resolveIssuedLeaseReference(alias, 4)).rejects.toThrow();
    const next = mintLease(identity, 5);
    try {
      expect(
        await resolveIssuedLeaseReference(issuedLeaseReference(next.lease), 5),
      ).toBe(next.lease);
    } finally {
      next.abort("fixture-close");
    }
  } finally {
    try {
      parent?.abort("fixture-close");
      await flushRetiredCredentialTelemetry();
      vaultStore.lock();
      if (ownerCreated) {
        await vaultStore.unlock(password);
        vaultStore.lock();
      }
    } finally {
      stop();
      configureHost(originalHost);
    }
  }
});

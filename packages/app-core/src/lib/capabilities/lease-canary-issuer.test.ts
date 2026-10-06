import type { PlanIdentity } from "@opensesame/capability-composition";
import { describe, expect, it } from "vitest";
import {
  configureLeaseIssuerScope,
  listRetiredLeaseIdentifiers,
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
describe("actual lease issuer lifecycle", () => {
  it("only exposes already-aborted actual generations and rejects a successor vault", async () => {
    let vaultIdentity = "manifest:original";
    const stop = configureLeaseIssuerScope(() => ({
      tomb: "personal",
      vaultIdentity,
    }));
    try {
      const minted = mintLease(identity, 41);
      expect(listRetiredLeaseIdentifiers("personal")).toEqual([]);
      minted.abort("vault-lock");
      const [record] = listRetiredLeaseIdentifiers("personal");
      expect(record?.context).toEqual({
        vaultIdentity: "manifest:original",
        kind: "agent_lease",
        generation: 41,
      });
      if (!record) throw new Error("missing actual issued record");
      const resolved = await resolveRetiredLeaseIdentifier(
        record.issuerRecordRef,
        "personal",
      );
      expect(resolved.presentedId).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(minted.lease.signal.aborted).toBe(true);
      await expect(
        resolveRetiredLeaseIdentifier(record.issuerRecordRef, "other"),
      ).rejects.toThrow();
      vaultIdentity = "manifest:successor";
      expect(listRetiredLeaseIdentifiers("personal")).toEqual([]);
      await expect(
        resolveRetiredLeaseIdentifier(record.issuerRecordRef, "personal"),
      ).rejects.toThrow();
      await expect(
        resolveRetiredLeaseIdentifier("oslease:v1:forged", "personal"),
      ).rejects.toThrow();
    } finally {
      stop();
    }
  });
});

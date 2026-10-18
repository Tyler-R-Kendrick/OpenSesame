import { vi } from "vitest";
import { backupEgressGate } from "./backup-egress-gate.js";
import { mintLease } from "./capabilities/lease.js";
import { compositionStore } from "./capabilities/store.js";

/** Real minted lease; a controlled policy port keeps these protocol tests independent of catalog fixtures. */
export function allowGithub() {
  const minted = mintLease(
    {
      instanceId: "instance",
      installationId: "installation",
      vaultId: null,
      distributionId: "distribution",
      policyRevision: "r1",
      selectionRevision: "s1",
      planDigest: `sha256:${"0".repeat(64)}`,
    },
    4,
  );
  vi.spyOn(compositionStore, "currentLease").mockReturnValue(minted.lease);
  vi.spyOn(compositionStore, "getSnapshot").mockReturnValue({
    ...compositionStore.getSnapshot(),
    generation: 4,
  });
  vi.spyOn(backupEgressGate, "running").mockReturnValue(true);
  const network = vi.spyOn(backupEgressGate, "network").mockReturnValue({
    externalServices: "allow",
    allowedServiceOrigins: ["https://api.github.com"],
  });
  return { revoke: () => minted.abort("withdrawn"), network };
}

/** Genuine local crypto owner; public snapshot doubles alone cannot authorize credential egress. */
export async function openGithubTestOwner() {
  const { vaultStore } = await import("./vault/store.js");
  const { vfsFlush } = await import("./vfs.js");
  const { kvFlush, kvForgetAll } = await import("./kv.js");
  await vaultStore.flushPendingWrites();
  vaultStore.lock();
  await vfsFlush();
  await kvFlush();
  kvForgetAll();
  vaultStore.loadActiveProjectScope();
  await vaultStore.create("genuine GitHub registration owner fixture 53947");
}

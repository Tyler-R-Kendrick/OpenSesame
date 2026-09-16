/**
 * Simulation-mode shared-ancestor overspend (NOT contract verification).
 *
 * Real MetaMask enforcer proofs belong to wallet:test:contracts once BUILD
 * ships a local-chain harness.
 */

import { describe, expect, it } from "vitest";
import {
  DELEGATION_FRAMEWORK_CANDIDATE_COMMIT,
  createDirectErc20DelegationAdapter,
} from "./direct-erc20-delegation.js";
import { InMemorySharedAncestorCounter } from "./simulation.js";
import type { PaymentIntent, SpendingLease } from "./types.js";

const ROOT = "root-accounting-shared";

function tokenIntent(amount: bigint): PaymentIntent {
  return {
    id: "intent-1",
    walletRef: "wallet-1",
    leaseRef: "lease-1",
    allocationRef: "alloc-1",
    destinationRef: "dest-0xabc",
    asset: {
      kind: "token",
      chainId: "31337",
      contract: "0xtoken",
      decimals: 6,
      deploymentFingerprint: "fp-test",
    },
    amount,
    maxFeeExposure: 0n,
    requestCommitment: "req-1",
    requesterRef: "agent-1",
    expectedProofKeyThumbprint: "thumb-1",
    protocolProfileVersion: "evm.direct-erc20-delegation.v0",
    validFrom: "2026-01-01T00:00:00Z",
    validUntil: "2026-12-31T00:00:00Z",
    idempotencyScope: "scope-1",
    requiredEnforcement: "independent_execution",
    executionEnvironment: "simulation",
  };
}

function lease(): SpendingLease {
  return {
    id: "lease-1",
    grantRef: "grant-1",
    allocationRef: "alloc-1",
    policyVersion: "1",
    beneficiaryRef: "ben-1",
    proofKeyThumbprint: "thumb-1",
    validFrom: "2026-01-01T00:00:00Z",
    validUntil: "2026-12-31T00:00:00Z",
    requiredEnforcementDigest: "req-enf",
    effectiveEnforcementDigest: "eff-enf",
    rootAccountingRef: ROOT,
  };
}

describe("directErc20Delegation", () => {
  it("describe reports source_inspected and productionEnabled false", async () => {
    const adapter = createDirectErc20DelegationAdapter();
    const manifest = await adapter.describe({
      origin: "http://localhost:5180",
      nowIso: "2026-09-15T00:00:00Z",
    });
    expect(manifest.adapterId).toBe("directErc20Delegation");
    expect(manifest.sourceCommit).toBe(DELEGATION_FRAMEWORK_CANDIDATE_COMMIT);
    expect(manifest.evidenceStatus).toBe("source_inspected");
    expect(manifest.productionEnabled).toBe(false);
    expect(manifest.readiness.kind).toBe("awaiting_harness");
  });

  it("describe can report blocked", async () => {
    const adapter = createDirectErc20DelegationAdapter({
      blockDescribe: true,
    });
    const manifest = await adapter.describe({
      origin: "http://localhost:5180",
      nowIso: "2026-09-15T00:00:00Z",
    });
    expect(manifest.evidenceStatus).toBe("blocked");
    expect(manifest.productionEnabled).toBe(false);
  });

  it("live assess refuses independent enforcement until harness exists", async () => {
    const adapter = createDirectErc20DelegationAdapter({
      mode: { kind: "live" },
    });
    const assessment = await adapter.assess(tokenIntent(6n), lease());
    expect(assessment.kind).toBe("refused");
    if (assessment.kind !== "refused") return;
    expect(assessment.code).toBe("INDEPENDENT_ENFORCEMENT_UNAVAILABLE");
  });

  it("in-memory shared counter rejects second six-unit spend against ten", async () => {
    // NOT contract verification — pure TS semantic demo of shared-ancestor
    // overspend rejection under one constrained root.
    const enforcer = new InMemorySharedAncestorCounter();
    enforcer.openRoot(ROOT, 10n);

    const adapter = createDirectErc20DelegationAdapter({
      mode: { kind: "simulation", enforcer },
    });

    const assessment = await adapter.assess(tokenIntent(6n), lease());
    expect(assessment.kind).toBe("assessed");
    if (assessment.kind === "assessed") {
      expect(
        assessment.assumptions.some((a) =>
          a.includes("productionEnabled remains false"),
        ),
      ).toBe(true);
    }

    const first = await adapter.prepare({
      ref: "reserved-1",
      intentId: "intent-1",
      leaseId: "lease-child-a",
      rootAccountingRef: ROOT,
      amount: 6n,
      destinationRef: "dest-0xabc",
      expiresAt: "2026-12-31T00:00:00Z",
    });
    const firstObs = await adapter.execute(first);
    expect(firstObs.status).toBe("confirmed");
    expect(enforcer.spent(ROOT)).toBe(6n);
    expect(enforcer.remaining(ROOT)).toBe(4n);

    const second = await adapter.prepare({
      ref: "reserved-2",
      intentId: "intent-2",
      leaseId: "lease-child-b",
      rootAccountingRef: ROOT,
      amount: 6n,
      destinationRef: "dest-0xdef",
      expiresAt: "2026-12-31T00:00:00Z",
    });
    const secondObs = await adapter.execute(second);
    expect(secondObs.status).toBe("failed");
    expect(secondObs.detail).toContain("overspend");
    expect(enforcer.spent(ROOT)).toBe(6n);
    expect(enforcer.remaining(ROOT)).toBe(4n);
  });
});

it("refuses fee-on-transfer / rebase / callback token semantics (WAL-E10)", async () => {
  const adapter = createDirectErc20DelegationAdapter({
    mode: { kind: "simulation", enforcer: new InMemorySharedAncestorCounter() },
  });
  for (const transferSemantics of [
    "fee_on_transfer",
    "rebase",
    "callback",
    "unusual_return",
    "upgradeable",
  ] as const) {
    const intent = tokenIntent(10n);
    if (intent.asset.kind !== "token") {
      throw new Error("expected token asset");
    }
    const assessed = await adapter.assess(
      {
        ...intent,
        asset: { ...intent.asset, transferSemantics },
      },
      lease(),
    );
    expect(assessed.kind).toBe("refused");
    if (assessed.kind === "refused") {
      expect(assessed.detail).toMatch(/WAL-E10|unsupported/i);
      expect(
        assessed.unsupportedConstraints.some((c) =>
          c.includes(transferSemantics),
        ),
      ).toBe(true);
    }
  }
});

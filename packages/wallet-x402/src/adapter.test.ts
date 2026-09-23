import { describe, expect, it } from "vitest";
import {
  X402AdapterBlockedError,
  X402InsufficientAvailableError,
  assessX402Adapter,
  describeX402Adapter,
  executeX402Payment,
  prepareX402Payment,
  reconcileX402Payment,
} from "./adapter.js";
import type { LocalExactRuntime } from "./exact-settle.js";
import { fixtureChallenge, fixtureProfile } from "./fixtures.js";

function heldReservation(reservedAmount: string) {
  return { reservedAmount, commit: () => {}, release: () => {} };
}

function dummyRuntime(amount: string): LocalExactRuntime {
  return {
    rpcUrl: "http://127.0.0.1:9",
    chainId: 31337,
    payerPrivateKey:
      "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
    facilitatorPrivateKey:
      "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
    asset: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
    payTo: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    amount,
    network: "eip155:31337",
  };
}

describe("x402 adapter", () => {
  it("stays production-off without a local runtime", () => {
    const manifest = describeX402Adapter();
    expect(manifest.productionEnabled).toBe(false);
    expect(manifest.evidenceStatus).toBe("blocked");
  });

  it("may report local_execution_verified without enabling production", () => {
    const manifest = describeX402Adapter({ localExecutionVerified: true });
    expect(manifest.evidenceStatus).toBe("local_execution_verified");
    expect(manifest.productionEnabled).toBe(false);
  });

  it("assesses without unlocking production", () => {
    expect(
      assessX402Adapter({
        profile: fixtureProfile(),
        challenge: fixtureChallenge(),
      }).productionEnabled,
    ).toBe(false);
  });

  it("blocks prepare/execute/reconcile without a runtime", async () => {
    await expect(prepareX402Payment()).rejects.toBeInstanceOf(
      X402AdapterBlockedError,
    );
    await expect(executeX402Payment()).rejects.toBeInstanceOf(
      X402AdapterBlockedError,
    );
    await expect(reconcileX402Payment()).rejects.toBeInstanceOf(
      X402AdapterBlockedError,
    );
  });

  it("refuses a loopback userinfo RPC URL", async () => {
    await expect(
      prepareX402Payment({
        runtime: {
          ...dummyRuntime("1"),
          rpcUrl: "http://127.0.0.1:31337@attacker.example",
        },
        reservation: heldReservation("1"),
      }),
    ).rejects.toThrow("LOCAL_RPC_REQUIRED");
  });

  it("refuses prepare when the amount exceeds remaining allocation", async () => {
    await expect(
      prepareX402Payment({
        runtime: dummyRuntime("1000000"),
        reservation: heldReservation("1"),
      }),
    ).rejects.toBeInstanceOf(X402InsufficientAvailableError);
  });
});

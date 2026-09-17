import { describe, expect, it } from "vitest";
import {
  X402AdapterBlockedError,
  assessX402Adapter,
  describeX402Adapter,
  executeX402Payment,
  prepareX402Payment,
  reconcileX402Payment,
} from "./adapter.js";
import { fixtureChallenge, fixtureProfile } from "./fixtures.js";

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
});

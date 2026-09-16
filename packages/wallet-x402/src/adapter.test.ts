import { describe, expect, it } from "vitest";

import {
  X402AdapterBlockedError,
  X402_ADAPTER_BLOCKED_REASON,
  assessX402Adapter,
  describeX402Adapter,
  executeX402Payment,
  prepareX402Payment,
  reconcileX402Payment,
} from "./adapter.js";
import { fixtureChallenge, fixtureProfile } from "./fixtures.js";

describe("x402 adapter", () => {
  it("describes itself as blocked for local_execution with production off", () => {
    const manifest = describeX402Adapter();
    expect(manifest.adapterId).toBe("x402-exact");
    expect(manifest.evidenceStatus).toBe("blocked");
    expect(manifest.productionEnabled).toBe(false);
    expect(manifest.blockedReason).toBe(X402_ADAPTER_BLOCKED_REASON);
    expect(manifest.supportedSchemes).toEqual(["exact"]);
    expect(manifest.headers.paymentRequired).toBe("PAYMENT-REQUIRED");
  });

  it("assesses via pure functions without unlocking local_execution", () => {
    const assessment = assessX402Adapter({
      profile: fixtureProfile(),
      challenge: fixtureChallenge(),
    });
    expect(assessment.evidenceStatus).toBe("blocked");
    expect(assessment.productionEnabled).toBe(false);
  });

  it("blocks prepare/execute/reconcile until a harness exists", () => {
    expect(() => prepareX402Payment()).toThrow(X402AdapterBlockedError);
    expect(() => executeX402Payment()).toThrow(X402AdapterBlockedError);
    expect(() => reconcileX402Payment()).toThrow(X402AdapterBlockedError);
  });
});

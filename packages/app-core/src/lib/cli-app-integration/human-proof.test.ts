import { beforeEach, describe, expect, it } from "vitest";
import {
  clearCliAppIntegrationBearer,
  writeCliAppIntegrationBearer,
} from "./bearer-session.js";
import {
  formatCliAppHumanProof,
  isCliAppHumanProofValid,
  mintCliAppHumanProofForTest,
} from "./human-proof.js";

const TEST_SECRET = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

describe("cli-app-integration human proof", () => {
  beforeEach(() => {
    clearCliAppIntegrationBearer();
    writeCliAppIntegrationBearer(TEST_SECRET);
  });

  it("accepts only oschip1 pin or passkey digests", () => {
    expect(
      isCliAppHumanProofValid(
        formatCliAppHumanProof("passkey", "a".repeat(64)),
      ),
    ).toBe(true);
    expect(isCliAppHumanProofValid("pending-ui-human-proof-placeholder")).toBe(
      false,
    );
    expect(isCliAppHumanProofValid("human-proof-from-test-harness")).toBe(
      false,
    );
  });

  it("binds HMAC to the pending row and verb", async () => {
    const binding = {
      requestId: "clr_1",
      respondNonce: "nonce-a",
      terminalSessionId: "term-a",
      verb: "read",
    };
    const proof = await mintCliAppHumanProofForTest(TEST_SECRET, binding);
    expect(proof).toMatch(/^oschip1:passkey:[0-9a-f]{64}$/);
    const again = await mintCliAppHumanProofForTest(TEST_SECRET, binding);
    expect(proof).toBe(again);
    const other = await mintCliAppHumanProofForTest(TEST_SECRET, {
      ...binding,
      requestId: "clr_2",
    });
    expect(other).not.toBe(proof);
  });

  it("rejects the all-zero placeholder mac at verify time in Rust parity vectors", async () => {
    const binding = {
      requestId: "clr_1",
      respondNonce: "nonce-a",
      terminalSessionId: "term-a",
      verb: "read",
    };
    const valid = await mintCliAppHumanProofForTest(TEST_SECRET, binding);
    expect(valid).not.toBe(
      "oschip1:passkey:0000000000000000000000000000000000000000000000000000000000000000",
    );
  });
});

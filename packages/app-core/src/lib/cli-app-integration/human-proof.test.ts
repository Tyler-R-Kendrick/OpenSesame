import { beforeEach, describe, expect, it } from "vitest";
import {
  clearCliAppIntegrationBearer,
  writeCliAppIntegrationBearer,
} from "./bearer-session.js";
import { formatCliAppHumanProofPin } from "./device-crypto.js";

const TEST_SECRET = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

function isCliAppHumanProofValid(proof: string): boolean {
  const t = proof.trim();
  return (
    /^oschip2:pin:([A-Za-z0-9_-]+)$/.test(t) || /^oschip2:passkey:(.+)$/.test(t)
  );
}

describe("cli-app-integration human proof", () => {
  beforeEach(() => {
    clearCliAppIntegrationBearer();
    writeCliAppIntegrationBearer(TEST_SECRET);
  });

  it("accepts only oschip2 pin or passkey payloads", () => {
    expect(
      isCliAppHumanProofValid(
        formatCliAppHumanProofPin(
          "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        ),
      ),
    ).toBe(true);
    expect(
      isCliAppHumanProofValid('oschip2:passkey:{"credentialIdB64":"x"}'),
    ).toBe(true);
    expect(isCliAppHumanProofValid("pending-ui-human-proof-placeholder")).toBe(
      false,
    );
    expect(isCliAppHumanProofValid("human-proof-from-test-harness")).toBe(
      false,
    );
    expect(
      isCliAppHumanProofValid(
        "oschip1:pin:0000000000000000000000000000000000000000000000000000000000000000",
      ),
    ).toBe(false);
  });
});

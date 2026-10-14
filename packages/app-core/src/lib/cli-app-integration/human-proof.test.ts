import { beforeEach, describe, expect, it } from "vitest";
import {
  clearCliAppIntegrationBearer,
  writeCliAppIntegrationBearer,
} from "./bearer-session.js";
import {
  formatCliAppHumanProofPin,
  isCliAppHumanProofValid,
} from "./human-proof-crypto.js";

const TEST_SECRET = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

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

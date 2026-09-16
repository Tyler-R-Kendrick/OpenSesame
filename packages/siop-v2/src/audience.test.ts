import type { JsonObject } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import { readAudience } from "./audience.js";
import { isSiopV2Error } from "./errors.js";

const expected = "https://rp.example/callback";

function expectAudienceRefusal(payload: JsonObject): void {
  try {
    readAudience(payload, expected);
    expect.unreachable("expected audience_mismatch");
  } catch (err) {
    expect(err instanceof Error && isSiopV2Error(err)).toBe(true);
    if (err instanceof Error && isSiopV2Error(err)) {
      expect(err.code).toBe("audience_mismatch");
      expect(err.checkpoint).toBe("audience_binding");
    }
  }
}

describe("readAudience", () => {
  it("returns matching string aud", () => {
    expect(readAudience({ aud: expected }, expected)).toBe(expected);
  });

  it("refuses wrong string aud", () => {
    expectAudienceRefusal({ aud: "https://other.example/cb" });
  });

  it("returns matching single-element string array", () => {
    expect(readAudience({ aud: [expected] }, expected)).toBe(expected);
  });

  it("refuses wrong single-element array entry", () => {
    expectAudienceRefusal({ aud: ["https://other.example/cb"] });
  });

  it("refuses empty aud array", () => {
    expectAudienceRefusal({ aud: [] });
  });

  it("refuses multi-entry aud arrays", () => {
    expectAudienceRefusal({
      aud: [expected, "https://other.example/cb"],
    });
  });

  it("refuses non-string array entry", () => {
    expectAudienceRefusal({ aud: [42] });
  });

  it("refuses missing or non-string scalar aud", () => {
    expectAudienceRefusal({});
    expectAudienceRefusal({ aud: 1 });
    expectAudienceRefusal({ aud: true });
    expectAudienceRefusal({ aud: { client: expected } });
  });
});

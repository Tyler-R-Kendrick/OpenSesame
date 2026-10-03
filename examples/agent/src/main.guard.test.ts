import { describe, expect, it } from "vitest";
import { createMockFetch, runAnonymousAgentDemo } from "./main.js";

describe("example-agent guard", () => {
  it("fails closed if the redacted payload still carries the claimToken", async () => {
    // A redactor that removes nothing stands in for a shape no scrubber knows:
    // only the guard behind the redaction catches it.
    await expect(
      runAnonymousAgentDemo({
        fetchImpl: createMockFetch(),
        sleep: async () => undefined,
        redact: (value) => value,
      }),
    ).rejects.toThrow("claimToken was not redacted");
  });
});

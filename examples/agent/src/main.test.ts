import { describe, expect, it } from "vitest";
import { runAnonymousAgentDemo } from "./main.js";

describe("example-agent", () => {
  it("registers anonymously and polls claim to completed", async () => {
    process.env.MOCK_AGENT_FLOW = "1";
    const result = await runAnonymousAgentDemo({
      pollTimes: 3,
      sleep: async () => undefined,
    });
    expect(result.claimId).toBe("clm_demo");
    expect(result.finalState).toBe("completed");
  });
});

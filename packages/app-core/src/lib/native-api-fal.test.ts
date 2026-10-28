import { describe, expect, it } from "vitest";
import { testNativeApiCredential } from "./native-api-connectors.js";
import {
  installNativeApiTests,
  nativeAnswers,
} from "./native-api.test-support.js";

installNativeApiTests();
const draft = {
  providerId: "fal-ai",
  parameters: { request_id: "request-1" },
  credentials: { api_key: "synthetic-token" },
};

describe("fal queue verification", () => {
  it("accepts the requested queue status", async () => {
    const provider = nativeAnswers({
      body: { status: "COMPLETED", request_id: "request-1" },
    });
    const result = await testNativeApiCredential(draft, provider.transport);
    expect(result.label).toBe("COMPLETED");
  });
  it("rejects a response for a different request", async () => {
    const provider = nativeAnswers({
      body: { status: "COMPLETED", request_id: "different" },
    });
    await expect(
      testNativeApiCredential(draft, provider.transport),
    ).rejects.toThrow();
  });
});

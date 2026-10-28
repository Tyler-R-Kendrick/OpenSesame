import { describe, expect, it } from "vitest";
import { testNativeApiCredential } from "./native-api-connectors.js";
import {
  installNativeApiTests,
  nativeAnswers,
} from "./native-api.test-support.js";

installNativeApiTests();
const requestId = "d7e6c0f3-6699-4f6c-bb45-2ad7fd9158ff";
const credentials = { api_key: "test-id", key_secret: "test-secret" };
const draft = (request_id: string) => ({
  providerId: "higgsfield",
  parameters: { request_id },
  credentials,
});

describe("Higgsfield status verification", () => {
  it("reads an existing request's status using the scoped key pair", async () => {
    const provider = nativeAnswers({
      body: { status: "completed", request_id: requestId },
    });
    const answer = await testNativeApiCredential(
      draft(requestId),
      provider.transport,
    );
    expect(answer.label).toBe("completed");
    expect(provider.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = provider.fetch.mock.calls[0] ?? [];
    expect(String(url)).toBe(
      `https://api.higgsfield.ai/requests/${requestId}/status`,
    );
    expect(init?.method).toBe("GET");
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Key test-id:test-secret",
    );
  });

  it.each(["", ".", "..", "../status", "request-1"])(
    "makes no request for invalid ID %s",
    async (id) => {
      const provider = nativeAnswers({ body: {} });
      await expect(
        testNativeApiCredential(draft(id), provider.transport),
      ).rejects.toThrow();
      expect(provider.fetch).not.toHaveBeenCalled();
    },
  );

  it.each([
    { status: 401, body: { error: "bad key" } },
    { status: 200, body: { status: "completed" } },
    { status: 200, body: { request_id: requestId } },
  ])("does not verify a refusal or incomplete response", async (reply) => {
    const provider = nativeAnswers(reply);
    await expect(
      testNativeApiCredential(draft(requestId), provider.transport),
    ).rejects.toThrow();
  });
});

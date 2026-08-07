import { describe, expect, it } from "vitest";
import { createApiClient } from "./index.js";

describe("api-client", () => {
  it("builds requests against host base url", async () => {
    const calls: string[] = [];
    const client = createApiClient({
      baseUrl: "http://host.test:8787/",
      fetchImpl: async (input) => {
        calls.push(String(input));
        return new Response("ok", { status: 200 });
      },
    });
    await client.health();
    expect(calls[0]).toBe("http://host.test:8787/health/live");
  });

  it("probeDaemon returns unavailable on network error", async () => {
    const client = createApiClient({
      baseUrl: "http://host.test:8787",
      fetchImpl: async () => {
        throw new Error("offline");
      },
    });
    const probe = await client.probeDaemon("http://127.0.0.1:18790");
    expect(probe.available).toBe(false);
  });
});

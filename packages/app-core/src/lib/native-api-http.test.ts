import { describe, expect, it, vi } from "vitest";
import { EgressDenied } from "./capabilities/egress.js";
import { nativeApiHttp } from "./native-api-http.js";

describe("bounded provider HTTP boundary", () => {
  const request = {
    url: "https://api.telegram.org/botprivate-key/getMe",
    method: "GET" as const,
    headers: new Headers(),
  };
  it("distinguishes deployment refusal without exposing the credential-bearing endpoint", async () => {
    const transport = {
      fetch: vi.fn(async () => {
        throw new EgressDenied(
          "local-authority-not-permitted",
          "connectors.external",
          String(request.url),
        );
      }),
      assertCurrent: vi.fn(),
    };
    await expect(nativeApiHttp(request, transport)).rejects.toMatchObject({
      code: "deployment",
      message: "This deployment does not permit this provider endpoint",
    });
  });
  it.each(["invalid JSON", JSON.stringify({ text: "a".repeat(262144) })])(
    "refuses malformed or oversized response without reflecting body",
    async (body) => {
      const transport = {
        fetch: vi.fn(async () => new Response(body)),
        assertCurrent: vi.fn(),
      };
      await expect(nativeApiHttp(request, transport)).rejects.toMatchObject({
        code: "response",
      });
    },
  );
  it("does not expose credential-bearing destination or provider text in errors", async () => {
    const transport = {
      fetch: vi.fn(async () => {
        throw new Error("Failed https://api.telegram.org/botprivate-key/getMe");
      }),
      assertCurrent: vi.fn(),
    };
    try {
      await nativeApiHttp(request, transport);
      throw new Error("Expected failure");
    } catch (error) {
      expect(error).toMatchObject({ code: "network" });
      expect(String(error)).not.toContain("private-key");
    }
  });
  it("uses browser CORS without cookies, redirect following, caching, or referrers", async () => {
    const transport = {
      fetch: vi.fn(
        async (_url: RequestInfo | URL, _init?: RequestInit) =>
          new Response("{}"),
      ),
      assertCurrent: vi.fn(),
    };
    await nativeApiHttp(request, transport);
    expect(transport.fetch.mock.calls[0]?.[1]).toMatchObject({
      mode: "cors",
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      referrerPolicy: "no-referrer",
    });
  });
});

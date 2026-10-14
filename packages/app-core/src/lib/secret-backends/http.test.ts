import { describe, expect, it } from "vitest";
import { createBackendHttp, secretBackendUrl } from "./http.js";
import type { SecretBackendFetch } from "./types.js";

describe("browser secret backend transport", () => {
  it("pins credentials to the configured origin and mount path and refuses redirects", async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const fetcher: SecretBackendFetch = async (url, init) => {
      calls.push({ url: String(url), init });
      return Response.json({ items: [] });
    };
    const request = createBackendHttp(
      "https://secrets.example.test/connect",
      fetcher,
    );
    await request("/v1/vaults", {
      headers: { Authorization: "Bearer scoped-fixture" },
    });
    expect(calls[0]).toMatchObject({
      url: "https://secrets.example.test/connect/v1/vaults",
      init: {
        redirect: "error",
        credentials: "omit",
        cache: "no-store",
        referrerPolicy: "no-referrer",
      },
    });
    await expect(
      request("https://other.example.test/steal"),
    ).rejects.toMatchObject({ code: "configuration" });
    await expect(request("../steal")).rejects.toMatchObject({
      code: "configuration",
    });
    expect(calls).toHaveLength(1);
  });

  it("rejects credentials in URLs and insecure remote endpoints", () => {
    for (const value of [
      "https://user:password@example.test",
      "http://example.test",
      "https://example.test?token=x",
      "https://example.test#secret",
      "file:///etc/passwd",
    ])
      expect(() => secretBackendUrl(value)).toThrow();
    expect(secretBackendUrl("http://localhost:41902").href).toBe(
      "http://localhost:41902/",
    );
  });

  it("sanitizes provider errors instead of reflecting response secrets", async () => {
    const request = createBackendHttp(
      "https://secrets.example.test",
      async () => new Response("credential=private-fixture", { status: 403 }),
    );
    await expect(request("items")).rejects.toMatchObject({
      code: "authentication",
    });
    await expect(request("items")).rejects.not.toThrow("private-fixture");
    const unavailable = createBackendHttp(
      "https://secrets.example.test",
      async () => {
        throw new Error("token=private-fixture");
      },
    );
    await expect(unavailable("items")).rejects.toMatchObject({
      code: "network",
    });
  });

  it("bounds streamed responses even without a content length", async () => {
    const request = createBackendHttp(
      "https://secrets.example.test",
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1));
              controller.close();
            },
          }),
        ),
    );
    await expect(request("items")).rejects.toMatchObject({ code: "response" });
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SecretBackendHttpError,
  createBackendHttp,
  secretBackendUrl,
} from "./http.js";
import { SecretBackendError, type SecretBackendFetch } from "./types.js";

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

async function rejectedRequest(
  fetcher: SecretBackendFetch,
): Promise<SecretBackendError> {
  const request = createBackendHttp("https://configured.example.test", fetcher);
  try {
    await request("/items", {
      headers: { authorization: "Bearer private-request-fixture" },
    });
  } catch (error) {
    if (error instanceof SecretBackendError) return error;
    throw error;
  }
  throw new Error("Expected a controlled request failure");
}

afterEach(() => vi.restoreAllMocks());

describe("safe HTTP status evidence", () => {
  it.each([
    {
      status: 401,
      code: "authentication",
      message: "The backend refused these credentials or permissions.",
    },
    {
      status: 403,
      code: "authentication",
      message: "The backend refused these credentials or permissions.",
    },
    {
      status: 404,
      code: "not-found",
      message: "The requested backend item was not found.",
    },
    {
      status: 429,
      code: "response",
      message: "The backend request failed (HTTP 429).",
    },
    {
      status: 500,
      code: "response",
      message: "The backend request failed (HTTP 500).",
    },
  ])(
    "preserves sanitized legacy behavior and exact status $status",
    async ({ status, code, message }) => {
      const response = new Response("private-response-body-fixture", {
        status,
        headers: { "x-private-header": "private-response-header-fixture" },
      });
      const error = await rejectedRequest(async () => response);
      expect(error).toBeInstanceOf(SecretBackendHttpError);
      expect(error).toBeInstanceOf(SecretBackendError);
      expect(error).toMatchObject({
        code,
        message,
        name: "SecretBackendError",
        status,
      });
      const retained = JSON.stringify(Object.getOwnPropertyDescriptors(error));
      expect(retained).not.toContain("private-response");
      expect(retained).not.toContain("private-request");
      expect(retained).not.toContain("configured.example.test");
      expect(error).not.toHaveProperty("response");
      expect(error).not.toHaveProperty("headers");
      expect(error).not.toHaveProperty("cause");
    },
  );

  it("does not turn an arbitrary thrown status/body into HTTP authority evidence", async () => {
    const thrown = Object.assign(new Error("private-fetch-detail-fixture"), {
      status: 401,
      body: "private-thrown-body-fixture",
    });
    const error = await rejectedRequest(async () => {
      throw thrown;
    });
    expect(error.code).toBe("network");
    expect(error.name).toBe("SecretBackendError");
    expect(error).not.toBeInstanceOf(SecretBackendHttpError);
    expect(error).not.toHaveProperty("status");
    expect(error).not.toHaveProperty("cause");
    expect(
      JSON.stringify(Object.getOwnPropertyDescriptors(error)),
    ).not.toContain("private-");
  });

  it("keeps malformed successful JSON a generic response failure", async () => {
    const error = await rejectedRequest(
      async () =>
        new Response("private-malformed-json-fixture", { status: 200 }),
    );
    expect(error).toMatchObject({
      code: "response",
      message: "The backend returned an unreadable response.",
      name: "SecretBackendError",
    });
    expect(error).not.toBeInstanceOf(SecretBackendHttpError);
    expect(error).not.toHaveProperty("status");
    expect(error.message).not.toContain("private-malformed");
  });

  it("does not promote a status-zero response to a typed HTTP failure", async () => {
    const error = await rejectedRequest(async () => Response.error());
    expect(error).toMatchObject({
      code: "response",
      message: "The backend request failed (HTTP 0).",
    });
    expect(error).not.toBeInstanceOf(SecretBackendHttpError);
    expect(error).not.toHaveProperty("status");
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 99, 600, 401.5])(
    "refuses invalid numeric status metadata %s",
    async (status) => {
      const response = Response.error();
      Object.defineProperty(response, "status", { value: status });
      const error = await rejectedRequest(async () => response);
      expect(error.code).toBe("response");
      expect(error).not.toBeInstanceOf(SecretBackendHttpError);
      expect(error).not.toHaveProperty("status");
    },
  );

  it("preserves the existing twenty-second default request bound", async () => {
    const bound = new AbortController();
    const timeout = vi
      .spyOn(AbortSignal, "timeout")
      .mockReturnValue(bound.signal);
    const fetcher = vi.fn<SecretBackendFetch>(async () =>
      Response.json({ items: [] }),
    );
    const request = createBackendHttp(
      "https://configured.example.test",
      fetcher,
    );
    await expect(request("/items")).resolves.toEqual({ items: [] });
    expect(timeout).toHaveBeenCalledExactlyOnceWith(20_000);
    expect(fetcher.mock.calls[0]?.[1]?.signal).toBe(bound.signal);
  });
});

import { describe, expect, it, vi } from "vitest";
import { target } from "./native-mcp-oauth-fixtures.test-helper.js";
import { nativeMcpOAuthFetch } from "./native-mcp-oauth-http.js";

describe("public MCP OAuth captured transport", () => {
  it("uses the settlement port exclusively for credential-issuing posts", async () => {
    const ordinary = vi.fn(async () => new Response("{}"));
    const settle = vi.fn(async () => new Response("{}"));
    const admitted = nativeMcpOAuthFetch(
      target,
      ordinary,
      new AbortController().signal,
      () => undefined,
      settle,
    );
    await admitted(target.metadata.discoveryUrl ?? "");
    await admitted(target.metadata.registrationEndpoint ?? "", {
      method: "POST",
    });
    await admitted(target.metadata.tokenEndpoint, { method: "POST" });
    await admitted(target.metadata.revocationEndpoint ?? "", {
      method: "POST",
    });
    expect(ordinary).toHaveBeenCalledTimes(2);
    expect(settle).toHaveBeenCalledTimes(2);
  });

  it("retains a late minted response for compensation while refusing every subsequent call", async () => {
    const lifetime = new AbortController();
    let current = true;
    const settle = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        lifetime.abort();
        current = false;
        expect(init?.signal?.aborted).toBe(false);
        return new Response(
          JSON.stringify({ access_token: "issued-after-disable" }),
        );
      },
    );
    const ordinary = vi.fn(async () => new Response("{}"));
    const admitted = nativeMcpOAuthFetch(
      target,
      ordinary,
      lifetime.signal,
      () => {
        if (!current) throw new Error("disposed lease");
      },
      settle,
    );
    const result = await admitted(target.metadata.tokenEndpoint, {
      method: "POST",
    });
    expect(await result.json()).toEqual({
      access_token: "issued-after-disable",
    });
    await expect(
      admitted(target.metadata.tokenEndpoint, { method: "POST" }),
    ).rejects.toThrow();
    expect(settle).toHaveBeenCalledTimes(1);
    expect(ordinary).not.toHaveBeenCalled();
  });

  it("rejects a late ordinary response and aborts its captured request", async () => {
    const lifetime = new AbortController();
    const ordinary = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        lifetime.abort();
        expect(init?.signal?.aborted).toBe(true);
        return new Response("{}");
      },
    );
    const admitted = nativeMcpOAuthFetch(
      target,
      ordinary,
      lifetime.signal,
      () => undefined,
    );
    await expect(
      admitted(target.metadata.discoveryUrl ?? ""),
    ).rejects.toMatchObject({ code: "disposed" });
  });

  it("refuses unrelated destinations, bearer headers and redirected responses", async () => {
    const ordinary = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://other.example.org" },
        }),
    );
    const admitted = nativeMcpOAuthFetch(
      target,
      ordinary,
      new AbortController().signal,
      () => undefined,
    );
    await expect(
      admitted("https://other.example.org/token", { method: "POST" }),
    ).rejects.toThrow();
    await expect(
      admitted(target.metadata.tokenEndpoint, {
        method: "POST",
        headers: { authorization: "Bearer private" },
      }),
    ).rejects.toThrow();
    expect(ordinary).not.toHaveBeenCalled();
    await expect(
      admitted(target.metadata.discoveryUrl ?? ""),
    ).rejects.toMatchObject({ code: "metadata" });
  });

  it("bounds streamed OAuth JSON before any SDK parse", async () => {
    const ordinary = vi.fn(
      async () => new Response("x".repeat(256 * 1024 + 1)),
    );
    const admitted = nativeMcpOAuthFetch(
      target,
      ordinary,
      new AbortController().signal,
      () => undefined,
    );
    await expect(
      admitted(target.metadata.discoveryUrl ?? ""),
    ).rejects.toMatchObject({ code: "metadata" });
  });
});

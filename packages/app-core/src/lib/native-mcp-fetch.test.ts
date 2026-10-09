import { describe, expect, it, vi } from "vitest";
import {
  type NativeMcpTransportPorts,
  nativeMcpFetch,
} from "./native-mcp-fetch.js";
import {
  type NativeMcpBinding,
  validateNativeMcpBinding,
} from "./native-mcp-target.js";

const binding: NativeMcpBinding = {
  providerId: "tenant-service",
  fingerprint: "configuration-1",
  endpoint: "https://mcp.example.org/tenant/acme/mcp",
  resource: "https://mcp.example.org/tenant/acme",
  issuer: "https://auth.example.org",
  transport: "streamable-http",
};

function fixture(
  response = new Response("{}", {
    headers: { "content-type": "application/json" },
  }),
) {
  const ports: NativeMcpTransportPorts = {
    fetch: vi.fn(async () => response),
    accessGrant: vi.fn(async () => ({
      ...binding,
      token: "one-private-grant",
    })),
    assertCurrent: () => undefined,
    authorizationRequired: vi.fn(async () => undefined),
  };
  const lifetime = new AbortController();
  return {
    ports,
    lifetime,
    fetcher: nativeMcpFetch(binding, ports, lifetime.signal),
  };
}

describe("native MCP fetch admission", () => {
  it("binds bearer injection to the exact provider/resource/issuer/configuration", async () => {
    const { fetcher, ports } = fixture();
    await fetcher(binding.endpoint, {
      method: "POST",
      body: "request",
      headers: { authorization: "Bearer injected" },
    });
    expect(ports.fetch).toHaveBeenCalledOnce();
    const request = new Request(
      vi.mocked(ports.fetch).mock.calls[0]?.[0] ?? "",
      vi.mocked(ports.fetch).mock.calls[0]?.[1],
    );
    expect(request.headers.get("authorization")).toBe(
      "Bearer one-private-grant",
    );
    expect(request.credentials).toBe("omit");
    expect(request.redirect).toBe("manual");
    expect(await request.text()).toBe("request");
  });

  it.each([
    "https://other.example.org/tenant/acme/mcp",
    "https://mcp.example.org/tenant/other/mcp",
    `${binding.endpoint}?other=1`,
  ])(
    "rejects unrelated destination %s before reading credentials",
    async (url) => {
      const { fetcher, ports } = fixture();
      await expect(fetcher(url, { method: "POST" })).rejects.toMatchObject({
        code: "target",
      });
      expect(ports.accessGrant).not.toHaveBeenCalled();
      expect(ports.fetch).not.toHaveBeenCalled();
    },
  );

  it.each(["resource", "issuer", "fingerprint", "providerId"] as const)(
    "rejects a sealed grant with changed %s",
    async (field) => {
      const { fetcher, ports } = fixture();
      ports.accessGrant = async () => ({
        ...binding,
        token: "private",
        [field]: "different",
      });
      await expect(fetcher(binding.endpoint)).rejects.toMatchObject({
        code: "target",
      });
      expect(ports.fetch).not.toHaveBeenCalled();
    },
  );

  it("uses path boundaries when checking resource audiences", () => {
    expect(() =>
      validateNativeMcpBinding({
        ...binding,
        resource: "https://mcp.example.org/tenant/ac",
      }),
    ).toThrow();
    expect(() =>
      validateNativeMcpBinding({
        ...binding,
        endpoint: "http://mcp.example.org/tenant/acme/mcp",
      }),
    ).toThrow();
  });

  it("rejects redirects without following them or leaking provider response text", async () => {
    const { fetcher, ports } = fixture(
      new Response("private provider detail", {
        status: 302,
        headers: { location: "https://attacker.example.org" },
      }),
    );
    await expect(fetcher(binding.endpoint)).rejects.toMatchObject({
      code: "target",
    });
    expect(ports.fetch).toHaveBeenCalledOnce();
  });

  it("reports a browser network/CORS failure without claiming the provider connected", async () => {
    const { fetcher, ports } = fixture();
    ports.fetch = async () => {
      throw new TypeError("private upstream URL");
    };
    await expect(fetcher(binding.endpoint)).rejects.toMatchObject({
      code: "browser-transport",
    });
  });

  it("bounds streamed responses rather than trusting content length", async () => {
    const { fetcher } = fixture(
      new Response(new Uint8Array(4 * 1024 * 1024 + 1)),
    );
    const response = await fetcher(binding.endpoint);
    await expect(response.text()).rejects.toMatchObject({ code: "response" });
  });

  it("blocks a stale configuration after an awaited grant read", async () => {
    const { fetcher, ports } = fixture();
    let current = true;
    ports.assertCurrent = () => {
      if (!current) throw new Error("configuration changed");
    };
    ports.accessGrant = async () => {
      current = false;
      return { ...binding, token: "private" };
    };
    await expect(fetcher(binding.endpoint)).rejects.toThrow(
      "configuration changed",
    );
    expect(ports.fetch).not.toHaveBeenCalled();
  });

  it("aborts a pending request and rejects its late response after disposal", async () => {
    const { fetcher, ports, lifetime } = fixture();
    let release: (response: Response) => void = () => undefined;
    ports.fetch = async (_input, init) => {
      lifetime.abort();
      expect(init?.signal?.aborted).toBe(true);
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    };
    const pending = fetcher(binding.endpoint);
    await vi.waitFor(() => expect(lifetime.signal.aborted).toBe(true));
    release(new Response("late result"));
    await expect(pending).rejects.toMatchObject({ code: "disposed" });
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  localNetworkFetch,
  targetAddressSpaceFor,
} from "./local-network-fetch.js";

describe("local-network-fetch", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("classifies Tailscale Serve and loopback for LNA", () => {
    expect(targetAddressSpaceFor("https://box.tail123.ts.net/health")).toBe(
      "local",
    );
    expect(targetAddressSpaceFor("https://hello.ts.net/")).toBe("local");
    expect(targetAddressSpaceFor("http://100.64.1.8:18790")).toBe("local");
    expect(targetAddressSpaceFor("http://127.0.0.1:18790")).toBe("loopback");
    expect(targetAddressSpaceFor("https://example.com")).toBeUndefined();
  });

  it("aborts hung fetches even when the browser ignores AbortSignal.timeout", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              reject(init.signal?.reason ?? new Error("aborted"));
            });
          }),
      ),
    );
    await expect(
      localNetworkFetch("https://box.tail123.ts.net/health", {
        timeoutMs: 30,
      }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof DOMException ||
        (error instanceof Error && /timed out|abort/i.test(String(error))),
    );
    const init = (fetch as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as {
      targetAddressSpace?: string;
    };
    expect(init.targetAddressSpace).toBe("local");
  });
});

describe("local-network-fetch edges", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("leaves unparseable and public URLs unannotated", () => {
    expect(targetAddressSpaceFor("http://[::1")).toBeUndefined();
    expect(targetAddressSpaceFor("http://172.32.0.1")).toBeUndefined();
    expect(targetAddressSpaceFor("http://100.63.0.1")).toBeUndefined();
    expect(targetAddressSpaceFor("http://10.1.2.3")).toBe("local");
    expect(targetAddressSpaceFor("http://172.16.0.1")).toBe("local");
    expect(targetAddressSpaceFor("http://192.168.0.1")).toBe("local");
    expect(targetAddressSpaceFor("http://169.254.1.1")).toBe("local");
    expect(targetAddressSpaceFor("http://printer.local")).toBe("local");
    expect(targetAddressSpaceFor("http://devbox.localhost")).toBe("loopback");
  });

  it("propagates an outer abort signal into the fetch", async () => {
    const outer = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              reject(init.signal?.reason ?? new Error("aborted"));
            });
          }),
      ),
    );
    const pending = localNetworkFetch("https://example.com/x", {
      signal: outer.signal,
      timeoutMs: 5000,
    });
    outer.abort(new Error("user cancelled"));
    await expect(pending).rejects.toThrow(/cancelled/);
  });

  it("honors an already-aborted outer signal without fetching", async () => {
    const outer = new AbortController();
    outer.abort(new Error("pre-aborted"));
    const spy = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      Promise.reject(init?.signal?.reason ?? new Error("went anyway")),
    );
    vi.stubGlobal("fetch", spy);
    await expect(
      localNetworkFetch("https://example.com", { signal: outer.signal }),
    ).rejects.toThrow(/pre-aborted/);
  });
});

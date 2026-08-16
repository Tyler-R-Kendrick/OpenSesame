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

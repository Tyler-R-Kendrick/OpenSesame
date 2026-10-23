import { afterEach, describe, expect, it, vi } from "vitest";
import { applyConnectCallbackBase } from "./connect-callback.js";
import { relayFetch } from "./vercel-connect-relay.js";

afterEach(() => {
  applyConnectCallbackBase(undefined);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Connect relay transport", () => {
  it("aborts a stalled relay fetch and reports a timeout", async () => {
    vi.useFakeTimers();
    applyConnectCallbackBase("https://relay.example");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener(
              "abort",
              () =>
                reject(
                  new DOMException("The operation was aborted.", "AbortError"),
                ),
              { once: true },
            );
          }),
      ),
    );
    const pending = relayFetch("/v1/connect/connections");
    const rejected = expect(pending).rejects.toMatchObject({
      status: 0,
      code: "timeout",
    });
    await vi.advanceTimersByTimeAsync(8_000);
    await rejected;
  });

  it("keeps a caller's abort distinct from the relay's own timeout", async () => {
    applyConnectCallbackBase("https://relay.example");
    const outer = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener(
              "abort",
              () => reject(new DOMException("aborted", "AbortError")),
              { once: true },
            );
          }),
      ),
    );
    const pending = relayFetch("/v1/connect/connections", {
      signal: outer.signal,
    });
    const rejected = expect(pending).rejects.toMatchObject({
      code: "unreachable",
    });
    outer.abort();
    await rejected;
  });
});

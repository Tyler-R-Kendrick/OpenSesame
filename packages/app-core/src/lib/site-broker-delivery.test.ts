import { afterEach, describe, expect, it, vi } from "vitest";
import { deliverToRp } from "./site-broker.js";

describe("deliverToRp fallbacks", () => {
  const successMessage = {
    type: "opensesame:signin" as const,
    state: "s",
    id_token: "t",
    issuer: "https://shoo.dev",
    audience: "origin:https://pages.example",
    jwks_uri: "https://shoo.dev/.well-known/jwks.json",
    expires_at: "2026-08-16T12:00:00.000Z",
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("skips window.close when asked not to", () => {
    const postMessage = vi.fn();
    const close = vi.fn();
    vi.stubGlobal("window", {
      opener: { closed: false, postMessage },
      close,
    });
    const via = deliverToRp(successMessage, "http://localhost:5173", {
      close: false,
    });
    expect(via).toBe("postMessage");
    expect(close).not.toHaveBeenCalled();
  });

  it("retries postMessage when reading the opener throws", () => {
    const postMessage = vi.fn();
    let reads = 0;
    const opener = {
      postMessage,
      get closed(): boolean {
        reads += 1;
        if (reads === 1) throw new Error("cross-origin");
        return false;
      },
    };
    vi.stubGlobal("window", { opener, close: vi.fn() });
    const via = deliverToRp(successMessage, "http://localhost:5173");
    expect(via).toBe("postMessage");
    expect(postMessage).toHaveBeenCalledOnce();
  });

  it("never falls back to a token-bearing fragment even on the same origin", () => {
    const assign = vi.fn();
    vi.stubGlobal("window", { opener: null, close: vi.fn() });
    vi.stubGlobal("location", { assign });

    const via = deliverToRp(successMessage, "http://localhost:5173", {
      redirectUri: "http://localhost:5173/callback",
    });

    expect(via).toBe("none");
    expect(assign).not.toHaveBeenCalled();
  });

  it("refuses a fragment redirect to a different origin", () => {
    vi.stubGlobal("window", { opener: null, close: vi.fn() });
    const via = deliverToRp(successMessage, "http://localhost:5173", {
      redirectUri: "https://evil.example/callback",
    });
    expect(via).toBe("none");
  });

  it("refuses an unparseable redirect URI", () => {
    vi.stubGlobal("window", { opener: null, close: vi.fn() });
    const via = deliverToRp(successMessage, "http://localhost:5173", {
      redirectUri: "::nope::",
    });
    expect(via).toBe("none");
  });

  it("reports none when the opener is gone and no redirect was given", () => {
    vi.stubGlobal("window", { opener: { closed: true }, close: vi.fn() });
    expect(deliverToRp(successMessage, "http://localhost:5173")).toBe("none");
    vi.stubGlobal("window", { opener: null, close: vi.fn() });
    expect(deliverToRp(successMessage, "http://localhost:5173")).toBe("none");
  });
});

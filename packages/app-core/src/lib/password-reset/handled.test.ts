import { afterEach, describe, expect, it } from "vitest";
import { kvGet, kvSet } from "../kv.js";
import {
  HANDLED_KEY,
  LOOKBACK_MS,
  clearHandledForTest,
  handledKey,
  isHandled,
  markHandled,
  unmarkHandled,
} from "./handled.js";

afterEach(() => {
  clearHandledForTest();
});

describe("the ledger of reset messages already acted on", () => {
  it("files a login, a site and a message under a digest, the same each time", async () => {
    const key = await handledKey("login-1", "https://example.com", "m1");
    expect(key).toMatch(/^[0-9a-f]{32}$/);
    expect(await handledKey("login-1", "https://example.com", "m1")).toBe(key);
    expect(await handledKey("login-1", "https://example.com", "m2")).not.toBe(
      key,
    );
    expect(await handledKey("login-2", "https://example.com", "m1")).not.toBe(
      key,
    );
  });

  it("keeps the two ledgers apart", () => {
    markHandled("announced", "k", 1_000);
    expect(isHandled("announced", "k")).toBe(true);
    expect(isHandled("handedOff", "k")).toBe(false);
    markHandled("handedOff", "k", 1_000);
    unmarkHandled("handedOff", "k");
    expect(isHandled("handedOff", "k")).toBe(false);
    expect(isHandled("announced", "k")).toBe(true);
  });

  it("lets go of entries older than the look-back window, and writes no name", async () => {
    const key = await handledKey("login-1", "https://example.com", "m1");
    markHandled("announced", key, 1_000);
    markHandled("announced", "newer", 1_000 + LOOKBACK_MS + 1);
    expect(isHandled("announced", key)).toBe(false);
    expect(isHandled("announced", "newer")).toBe(true);
    const stored = kvGet(HANDLED_KEY) ?? "";
    expect(stored).not.toContain("example.com");
    expect(stored).not.toContain("login-1");
  });

  it("reads a damaged file as empty, and writes over it", () => {
    kvSet(HANDLED_KEY, "{not json");
    expect(isHandled("announced", "k")).toBe(false);
    markHandled("announced", "k", 1_000);
    expect(isHandled("announced", "k")).toBe(true);
  });
});

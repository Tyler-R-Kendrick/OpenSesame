import { afterEach, describe, expect, it, vi } from "vitest";
import { newUri } from "./model.js";
import { createItem } from "./model.js";
import { entryToVaultItem, vaultItemToEntry } from "./store-sync.js";
import {
  loginWebsiteLink,
  testWebsitePattern,
  validateWebsitePatterns,
} from "./website-pattern.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("hostname patterns", () => {
  it("never turns wildcard or regex rules into external links", () => {
    expect(loginWebsiteLink(newUri("*.example.com", "wildcard"))).toBeNull();
    expect(loginWebsiteLink(newUri("https://example.com", "regex"))).toBeNull();
    expect(loginWebsiteLink(newUri("example.com", "host"))).toBe(
      "https://example.com/",
    );
  });
  it("matches full hostnames with wildcard and regex semantics", async () => {
    const postMessage = vi.fn();
    const scope: {
      onmessage:
        | ((event: {
            data: { pattern: string; kind: string; hostname: string };
          }) => void)
        | null;
      postMessage: typeof postMessage;
    } = { onmessage: null, postMessage };
    vi.stubGlobal("self", scope);
    await import("./website-pattern.worker.js");
    for (const [kind, pattern, hostname, expected] of [
      ["wildcard", "*.example.com", "app.example.com", "match"],
      ["wildcard", "*.example.com", "example.com", "no-match"],
      ["wildcard", "*.example.com", "app.example.com.evil.test", "no-match"],
      ["wildcard", "app?.example.com", "app1.example.com", "match"],
      ["wildcard", "app?.example.com", "app12.example.com", "no-match"],
      ["wildcard", "https://*.example.com", "app.example.com", "invalid"],
      ["regex", "(.*\\.)?example\\.com", "example.com", "match"],
      ["regex", "(.*\\.)?example\\.com", "APP.EXAMPLE.COM", "match"],
      ["regex", "example\\.com", "notexample.com", "no-match"],
      ["regex", "[", "example.com", "invalid"],
      ["regex", "x".repeat(257), "example.com", "invalid"],
      ["never", ".*", "example.com", "invalid"],
    ]) {
      scope.onmessage?.({ data: { kind, pattern, hostname } });
      expect(postMessage).toHaveBeenLastCalledWith(expected);
    }
  });

  it("rejects unsafe targets and fails closed without a worker", async () => {
    const rule = newUri("*.example.com", "wildcard");
    for (const target of [
      "https://user@example.com",
      "file:///etc/passwd",
      "https://",
    ])
      expect(await testWebsitePattern(rule, target)).toBe("invalid");
    vi.stubGlobal("Worker", undefined);
    expect(await testWebsitePattern(rule, "https://app.example.com")).toBe(
      "unavailable",
    );
    await expect(validateWebsitePatterns([rule])).rejects.toThrow(
      "unavailable",
    );
    await expect(
      validateWebsitePatterns([newUri("https://example.com")]),
    ).resolves.toBeUndefined();
  });

  it("terminates a stuck worker and passes only the canonical hostname", async () => {
    vi.useFakeTimers();
    const terminate = vi.fn();
    const postMessage = vi.fn();
    vi.stubGlobal(
      "Worker",
      class {
        terminate = terminate;
        postMessage = postMessage;
      },
    );
    const result = testWebsitePattern(
      newUri("(a+)+", "regex"),
      "https://EXAMPLE.com./example.com?secret=not-sent",
    );
    expect(postMessage).toHaveBeenCalledWith({
      pattern: "(a+)+",
      kind: "regex",
      hostname: "example.com",
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(await result).toBe("timeout");
    expect(terminate).toHaveBeenCalledOnce();
  });

  it("preserves match modes through the sealed-store manifest", () => {
    const item = createItem("login", "Example");
    if (item.kind !== "login") throw new Error("Wrong fixture");
    item.uris = [
      newUri("", "never"),
      newUri("*.example.com", "wildcard"),
      newUri("example\\.com", "regex"),
    ];
    const restored = entryToVaultItem(vaultItemToEntry(item, []));
    if (restored.kind !== "login") throw new Error("Wrong restored type");
    expect(restored.uris.map(({ uri, match }) => ({ uri, match }))).toEqual([
      { uri: "*.example.com", match: "wildcard" },
      { uri: "example\\.com", match: "regex" },
    ]);
  });
});

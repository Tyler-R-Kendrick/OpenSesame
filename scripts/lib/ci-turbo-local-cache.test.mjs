import { describe, expect, it } from "vitest";
import { turboLocalCacheKey } from "./ci-turbo-local-cache.mjs";

describe("turboLocalCacheKey", () => {
  it("keys the cache by runner OS and lockfile digest", () => {
    const first = turboLocalCacheKey({ RUNNER_OS: "Linux" }, {
      lockDigest: "abc123",
    });
    const second = turboLocalCacheKey({ RUNNER_OS: "Linux" }, {
      lockDigest: "def456",
    });
    expect(first.key).toBe("turbo-local-Linux-abc123");
    expect(first.restorePrefix).toBe("turbo-local-Linux-");
    expect(second.key).not.toBe(first.key);
  });
});

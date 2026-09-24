import { describe, expect, it } from "vitest";
import { isClaimToken } from "./claim-link.js";
import { type StashStorage, createClaimStash } from "./claim-stash.js";

function memoryStorage(): StashStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

describe("claim stash, stricter reading", () => {
  it("forgets a stash past its horizon, and removes it", () => {
    const storage = memoryStorage();
    let now = 1_000;
    const stash = createClaimStash(() => storage, "k", {
      maxAgeMs: 100,
      now: () => now,
    });
    stash.write({ token: "osc_clm_a.b", presented: false });
    expect(stash.read()).toEqual({ token: "osc_clm_a.b", presented: false });
    now = 1_101;
    expect(stash.read()).toBeNull();
    expect(storage.map.has("k")).toBe(false);
  });

  it("adversarial: an unstamped or future-stamped record is not trusted", () => {
    const storage = memoryStorage();
    const stash = createClaimStash(() => storage, "k", {
      maxAgeMs: 100,
      now: () => 1_000,
    });
    storage.setItem(
      "k",
      JSON.stringify({ token: "osc_clm_a.b", presented: false }),
    );
    expect(stash.read()).toBeNull();
    storage.setItem(
      "k",
      JSON.stringify({ token: "osc_clm_a.b", presented: false, savedAt: 5e3 }),
    );
    expect(stash.read()).toBeNull();
  });

  it("removes a token of the wrong shape rather than resuming it", () => {
    const storage = memoryStorage();
    const stash = createClaimStash(() => storage, "k", {
      acceptToken: isClaimToken,
    });
    storage.setItem(
      "k",
      JSON.stringify({ token: "garbage", presented: false }),
    );
    expect(stash.read()).toBeNull();
    expect(storage.map.has("k")).toBe(false);
  });

  it("reads as before when no options are given", () => {
    const storage = memoryStorage();
    const stash = createClaimStash(() => storage);
    stash.write({ token: "anything", presented: false });
    expect(JSON.parse(storage.map.get("opensesame.claim") ?? "{}")).toEqual({
      token: "anything",
      presented: false,
    });
  });
});

import { describe, expect, it } from "vitest";
import { createDisabledNostrAdapter } from "../index.js";

describe("identity-nostr", () => {
  it("is disabled by default", async () => {
    const a = createDisabledNostrAdapter();
    expect(a.enabled).toBe(false);
    await expect(a.createChallenge()).rejects.toThrow(/disabled/);
  });
});

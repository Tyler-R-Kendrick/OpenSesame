import { describe, expect, it } from "vitest";
import { asyncRefusalOf } from "./__fixtures__/harness.js";
import type { Openid4vciErrorCode } from "./errors.js";
import { MemoryNonceStore } from "./nonce.js";

async function refusalCode(
  run: () => Promise<void>,
): Promise<Openid4vciErrorCode> {
  return (await asyncRefusalOf(run)).code;
}

describe("MemoryNonceStore", () => {
  it("issues unpredictable, distinct challenges", async () => {
    const store = new MemoryNonceStore();
    const values = new Set<string>();
    for (let index = 0; index < 64; index += 1) {
      values.add((await store.issue()).nonce);
    }
    expect(values.size).toBe(64);
    for (const value of values) expect(value.length).toBeGreaterThanOrEqual(43);
  });

  it("spends a nonce exactly once", async () => {
    const store = new MemoryNonceStore();
    const { nonce } = await store.issue();
    await expect(store.consume(nonce)).resolves.toBeUndefined();
    expect(await refusalCode(() => store.consume(nonce))).toBe(
      "nonce_replayed",
    );
  });

  it("refuses a nonce it never issued", async () => {
    const store = new MemoryNonceStore();
    expect(await refusalCode(() => store.consume("never-issued"))).toBe(
      "nonce_unknown",
    );
  });

  it("gives replay and unknown the same wire error, so neither is an oracle", async () => {
    const store = new MemoryNonceStore();
    const { nonce } = await store.issue();
    await store.consume(nonce);

    const replay = await asyncRefusalOf(() => store.consume(nonce));
    const unknown = await asyncRefusalOf(() => store.consume("never"));
    expect(replay.wireError).toBe("invalid_nonce");
    expect(unknown.wireError).toBe("invalid_nonce");
    expect(replay.message).toBe(unknown.message);
  });

  it("expires an unspent nonce", async () => {
    const store = new MemoryNonceStore(4096, 60);
    const start = new Date("2026-01-01T00:00:00Z");
    const { nonce } = await store.issue(start);
    expect(
      await refusalCode(() =>
        store.consume(nonce, new Date(start.getTime() + 61_000)),
      ),
    ).toBe("nonce_unknown");
  });

  it("stays bounded under an unauthenticated flood, evicting rather than refusing", async () => {
    const store = new MemoryNonceStore(8);
    const issued: string[] = [];
    for (let index = 0; index < 64; index += 1) {
      issued.push((await store.issue()).nonce);
    }
    expect(store.size).toBeLessThanOrEqual(8);

    // Issuance never failed under pressure: the newest challenge is live.
    const newest = issued.at(-1);
    if (newest === undefined) throw new Error("nothing was issued");
    await expect(store.consume(newest)).resolves.toBeUndefined();

    // The oldest was evicted, and an evicted nonce is refused, never accepted.
    const oldest = issued.at(0);
    if (oldest === undefined) throw new Error("nothing was issued");
    expect(await refusalCode(() => store.consume(oldest))).toBe(
      "nonce_unknown",
    );
  });

  it("never accepts an evicted-then-reoffered value twice", async () => {
    const store = new MemoryNonceStore(4);
    const { nonce } = await store.issue();
    await store.consume(nonce);
    for (let index = 0; index < 16; index += 1) await store.issue();
    // The tombstone may have been evicted, but the live entry certainly was.
    expect(["nonce_unknown", "nonce_replayed"]).toContain(
      await refusalCode(() => store.consume(nonce)),
    );
  });
});

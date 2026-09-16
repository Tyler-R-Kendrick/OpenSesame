import { describe, expect, it } from "vitest";
import { NonceStore, NonceStoreError } from "./nonce-store.js";

function claimCode(
  store: NonceStore,
  state: string,
  nowMs: number,
): NonceStoreError["code"] | "ok" {
  try {
    store.claim(state, nowMs);
    return "ok";
  } catch (error) {
    if (error instanceof NonceStoreError) return error.code;
    throw error;
  }
}

describe("NonceStore", () => {
  it("allows only one in-flight claim per state", () => {
    const store = new NonceStore();
    const now = 1_700_000_000;
    store.issue("state-a", "nonce-a", now);
    const row = store.claim("state-a", now);
    expect(row.nonce).toBe("nonce-a");
    expect(claimCode(store, "state-a", now)).toBe("unknown_state");
  });

  it("restores a claimed row so verify can retry", () => {
    const store = new NonceStore();
    const now = 1_700_000_000;
    store.issue("state-a", "nonce-a", now);
    const row = store.claim("state-a", now);
    store.restore("state-a", row);
    const again = store.claim("state-a", now);
    expect(again.nonce).toBe("nonce-a");
  });

  it("refuses claim after finish with state_replay", () => {
    const store = new NonceStore();
    const now = 1_700_000_000;
    store.issue("state-a", "nonce-a", now);
    store.claim("state-a", now);
    store.finish("state-a", now);
    expect(claimCode(store, "state-a", now)).toBe("state_replay");
  });

  it("serializes exclusivity: restore unlocks, finish consumes", () => {
    const store = new NonceStore();
    const now = 1_700_000_000;
    store.issue("state-a", "nonce-a", now);
    store.issue("state-b", "nonce-b", now);

    const claimedA = store.claim("state-a", now);
    expect(claimCode(store, "state-a", now)).toBe("unknown_state");
    store.restore("state-a", claimedA);
    expect(store.claim("state-a", now).nonce).toBe("nonce-a");
    store.finish("state-a", now);
    expect(claimCode(store, "state-a", now)).toBe("state_replay");

    expect(store.claim("state-b", now).nonce).toBe("nonce-b");
  });
});

import { afterEach, describe, expect, it } from "vitest";
import {
  clearClaimStash,
  readClaimStash,
  writeClaimStash,
} from "./claim-stash.js";

class MemoryStorage {
  private readonly store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
}

function installStorage(storage: unknown): void {
  Object.defineProperty(globalThis, "sessionStorage", {
    value: storage,
    configurable: true,
  });
}

afterEach(() => {
  Object.defineProperty(globalThis, "sessionStorage", {
    value: undefined,
    configurable: true,
  });
});

describe("claim stash", () => {
  it("returns null when nothing is stashed", () => {
    installStorage(new MemoryStorage());
    expect(readClaimStash()).toBeNull();
  });

  it("round-trips a full stash and forgets it on clear", () => {
    installStorage(new MemoryStorage());
    writeClaimStash({
      token: "osc_clm_a.secret",
      presented: true,
      claimId: "clm_1",
      principalId: "prn_1",
    });
    expect(readClaimStash()).toEqual({
      token: "osc_clm_a.secret",
      presented: true,
      claimId: "clm_1",
      principalId: "prn_1",
    });
    clearClaimStash();
    expect(readClaimStash()).toBeNull();
  });

  it("omits claimId and principalId unless they are strings", () => {
    const storage = new MemoryStorage();
    installStorage(storage);
    storage.setItem(
      "opensesame.claim",
      JSON.stringify({
        token: "osc_clm_a.secret",
        presented: false,
        claimId: 42,
        principalId: null,
      }),
    );
    expect(readClaimStash()).toEqual({
      token: "osc_clm_a.secret",
      presented: false,
    });
  });

  it("rejects stashes that are not JSON, not objects, or missing the bearer shape", () => {
    const storage = new MemoryStorage();
    installStorage(storage);
    for (const raw of [
      "not-json{",
      "null",
      "42",
      '"just a string"',
      JSON.stringify({ presented: false }),
      JSON.stringify({ token: 7, presented: false }),
      JSON.stringify({ token: "osc_clm_a.secret", presented: "yes" }),
    ]) {
      storage.setItem("opensesame.claim", raw);
      expect(readClaimStash(), raw).toBeNull();
    }
  });

  it("keeps working when storage is unavailable", () => {
    const broken = {
      getItem(): string | null {
        throw new Error("denied");
      },
      setItem(): void {
        throw new Error("denied");
      },
      removeItem(): void {
        throw new Error("denied");
      },
    };
    installStorage(broken);
    expect(() =>
      writeClaimStash({ token: "osc_clm_a.secret", presented: false }),
    ).not.toThrow();
    expect(readClaimStash()).toBeNull();
    expect(() => clearClaimStash()).not.toThrow();
  });

  it("treats a missing sessionStorage global as unavailable", () => {
    installStorage(undefined);
    expect(() =>
      writeClaimStash({ token: "osc_clm_a.secret", presented: false }),
    ).not.toThrow();
    expect(readClaimStash()).toBeNull();
    expect(() => clearClaimStash()).not.toThrow();
  });
});

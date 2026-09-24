/**
 * The claim stash, as Pages binds it. Ported from the console's
 * `claim-stash.test.ts` (every case below it asserted is asserted here), plus
 * the stricter reading this binding adds.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configureHost } from "../../host.js";
import { createMemoryStorage } from "../../memory-storage.js";
import type { WebStorage } from "../../ports.js";
import { createTestHost } from "../../test-host.js";
import {
  CLAIM_STASH_MAX_AGE_MS,
  claimStash,
  clearClaimStash,
  createPagesClaimStash,
} from "./stash.js";

const KEY = "opensesame.claim";
let storage: WebStorage;

function install(session: WebStorage | undefined): void {
  configureHost(createTestHost({ storage: { session } }));
}

beforeEach(() => {
  storage = createMemoryStorage();
  install(storage);
});

afterEach(() => configureHost(createTestHost()));

describe("claim stash (ported from the console)", () => {
  it("returns null when nothing is stashed", () => {
    expect(claimStash.read()).toBeNull();
  });

  it("round-trips a full stash and forgets it on clear", () => {
    const full = {
      token: "osc_clm_a.secret",
      presented: true,
      claimId: "clm_1",
      principalId: "prn_1",
    };
    claimStash.write(full);
    expect(claimStash.read()).toEqual(full);
    clearClaimStash();
    expect(claimStash.read()).toBeNull();
  });

  it("omits claimId and principalId unless they are strings", () => {
    storage.setItem(
      KEY,
      JSON.stringify({
        token: "osc_clm_a.secret",
        presented: false,
        claimId: 42,
        principalId: null,
        savedAt: Date.now(),
      }),
    );
    expect(claimStash.read()).toEqual({
      token: "osc_clm_a.secret",
      presented: false,
    });
  });

  it("rejects stashes that are not JSON, not objects, or missing the bearer shape", () => {
    const savedAt = Date.now();
    for (const raw of [
      "not-json{",
      "null",
      "42",
      '"just a string"',
      JSON.stringify({ presented: false, savedAt }),
      JSON.stringify({ token: 7, presented: false, savedAt }),
      JSON.stringify({ token: "osc_clm_a.secret", presented: "yes", savedAt }),
    ]) {
      storage.setItem(KEY, raw);
      expect(claimStash.read(), raw).toBeNull();
    }
  });

  it("keeps working when storage is unavailable", () => {
    const broken: WebStorage = {
      length: 0,
      key: () => null,
      getItem() {
        throw new Error("denied");
      },
      setItem() {
        throw new Error("denied");
      },
      removeItem() {
        throw new Error("denied");
      },
    };
    install(broken);
    expect(() =>
      claimStash.write({ token: "osc_clm_a.secret", presented: false }),
    ).not.toThrow();
    expect(claimStash.read()).toBeNull();
    expect(() => clearClaimStash()).not.toThrow();
  });

  it("treats a host with no session storage as unavailable", () => {
    install(undefined);
    expect(() =>
      claimStash.write({ token: "osc_clm_a.secret", presented: false }),
    ).not.toThrow();
    expect(claimStash.read()).toBeNull();
    expect(() => clearClaimStash()).not.toThrow();
  });
});

describe("claim stash, stricter than both app copies", () => {
  it("keeps only the bearer, the claim and the principal", () => {
    claimStash.write({
      token: "osc_clm_a.secret",
      presented: true,
      claimId: "clm_1",
      principalId: "prn_1",
    });
    const stored = JSON.parse(storage.getItem(KEY) ?? "{}");
    expect(Object.keys(stored).sort()).toEqual([
      "claimId",
      "presented",
      "principalId",
      "savedAt",
      "token",
    ]);
  });

  it("adversarial: a token that is not claim-shaped is removed, not resumed", () => {
    storage.setItem(
      KEY,
      JSON.stringify({ token: "osc_dlg_a.b", presented: false, savedAt: 1 }),
    );
    expect(claimStash.read()).toBeNull();
    expect(storage.getItem(KEY)).toBeNull();
  });

  it("forgets a stash older than the server's longest claim", () => {
    let now = 1_000_000;
    const stash = createPagesClaimStash(() => now);
    stash.write({ token: "osc_clm_a.secret", presented: false });
    now += CLAIM_STASH_MAX_AGE_MS;
    expect(stash.read()).not.toBeNull();
    now += 1;
    expect(stash.read()).toBeNull();
    expect(storage.getItem(KEY)).toBeNull();
  });

  it("does not trust a record written without a stamp (an app copy's)", () => {
    storage.setItem(
      KEY,
      JSON.stringify({ token: "osc_clm_a.secret", presented: false }),
    );
    expect(claimStash.read()).toBeNull();
  });
});

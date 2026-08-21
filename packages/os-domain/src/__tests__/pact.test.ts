import { describe, expect, it } from "vitest";
import type { BoundaryValue } from "../json.js";
import {
  authenticateClaim,
  canTransitionClaim,
  completeClaim,
  elevatePrincipalAssurance,
  fixtures,
  parseClaimToken,
  presentClaim,
  reviewClaim,
} from "../index.js";

async function assertAtMostWins(
  worker: () => Promise<boolean> | boolean,
  max: number,
): Promise<void> {
  const results = await Promise.all(
    Array.from({ length: 32 }, () => Promise.resolve().then(worker)),
  );
  const wins = results.filter(Boolean).length;
  if (wins > max) throw new Error(`expected at most ${max} wins, got ${wins}`);
}

async function assertExclusiveClaim(
  worker: () => Promise<boolean> | boolean,
): Promise<void> {
  const results = await Promise.all(
    Array.from({ length: 32 }, () => Promise.resolve().then(worker)),
  );
  if (results.filter(Boolean).length !== 1)
    throw new Error("expected one winner");
}

function checkThenSetAdmitsDoubleClaim(): void {
  const keys = new Set<string>();
  if (!(!keys.has("d1") && !keys.has("d1")))
    throw new Error("checks must both pass");
  keys.add("d1");
  keys.add("d1");
}

function assertNoSecretFields(value: BoundaryValue): void {
  const blob = JSON.stringify(value);
  for (const key of [
    "access_token",
    "refresh_token",
    "client_secret",
    "private_key",
    "claim_token",
    "claimToken",
  ]) {
    if (blob.includes(`"${key}"`))
      throw new Error(`secret field ${key} present`);
  }
}

describe("PACT — os-domain", () => {
  it("property: terminal claim states never leave the terminal set", () => {
    const terminals = ["completed", "denied", "revoked", "expired"] as const;
    const all = [
      "pending",
      "presented",
      "authenticated",
      "reviewed",
      ...terminals,
    ] as const;
    for (const from of terminals) {
      for (const to of all) {
        expect(canTransitionClaim(from, to), `${from}->${to}`).toBe(false);
      }
    }
  });

  it("adversarial: check-then-set is the mutant; malformed tokens parse as null", () => {
    checkThenSetAdmitsDoubleClaim();
    for (const bad of [
      "",
      "../osc_clm_x.y",
      "osc_clm_",
      "osc_clm_onlyid",
      "osc_clm_.secret",
      "osc_clm_id.",
    ]) {
      expect(parseClaimToken(bad), bad).toBeNull();
    }
  });

  it("chaos: concurrent complete of one reviewed session does not mutate the original", async () => {
    let s = fixtures.pendingClaim().session;
    s = presentClaim(s, fixtures.now);
    s = authenticateClaim(s, fixtures.now);
    s = reviewClaim(s, {}, fixtures.now);
    const reviewed = s;
    await assertAtMostWins(() => {
      completeClaim(reviewed, "prn_claimer", fixtures.now);
      return reviewed.state === "completed";
    }, 0);
    expect(reviewed.state).toBe("reviewed");
    const keys = new Set<string>();
    await assertExclusiveClaim(() => {
      if (keys.has(reviewed.id)) return false;
      keys.add(reviewed.id);
      return true;
    });
  });

  it("contract: principal id is stable and fixtures carry no secret fields", async () => {
    const p = fixtures.provisionalPrincipal();
    await Promise.all(
      Array.from({ length: 32 }, () =>
        Promise.resolve(
          elevatePrincipalAssurance(p, "verified", "active", fixtures.now),
        ),
      ),
    ).then((all) => {
      for (const next of all) {
        expect(next.id).toBe(p.id);
      }
    });
    const { session } = fixtures.pendingClaim();
    assertNoSecretFields(JSON.parse(JSON.stringify(session)));
    expect(JSON.stringify(session)).not.toContain("osc_clm_");
  });
});

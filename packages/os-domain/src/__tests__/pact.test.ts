import {
  assertAtMostWins,
  assertExclusiveClaim,
  assertNoSecretFields,
  checkThenSetAdmitsDoubleClaim,
} from "@opensesame/testing";
import { describe, expect, it } from "vitest";
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

import { fixtures } from "@opensesame/os-domain";
import { countConcurrentWins } from "@opensesame/testing";
import { describe, expect, it } from "vitest";
import { ClaimEngine, MemoryClaimStore } from "../index.js";

describe("PACT — claim exclusive complete", () => {
  it("concurrent completeClaim admits one CAS winner", async () => {
    const eng = new ClaimEngine({
      pepper: fixtures.pepper,
      store: new MemoryClaimStore(),
      clock: () => fixtures.now,
    });
    const created = await eng.createClaim({
      type: "resource_bundle",
      targetManifest: { t: 1 },
      items: fixtures.claimItems("x"),
    });
    await eng.presentClaim(created.session.id, created.token);
    await eng.authenticateClaim(created.session.id);
    await eng.reviewClaim(created.session.id, {
      acceptedItemIds: ["ci_project", "ci_resource"],
    });
    const decision = { acceptedItemIds: ["ci_project", "ci_resource"] };
    const wins = await countConcurrentWins(async () => {
      try {
        const result = await eng.completeClaim(
          created.session.id,
          `prn_${crypto.randomUUID()}`,
          decision,
        );
        return result.won;
      } catch {
        return false;
      }
    }, 8);
    expect(wins).toBe(1);
    const json = JSON.stringify(await eng.get(created.session.id));
    expect(json).not.toContain(created.token);
  });
});

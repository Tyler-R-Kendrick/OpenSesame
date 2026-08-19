import { describe, expect, it } from "vitest";
import {
  assertAtMostWins,
  assertDurableSurvivesPartition,
  assertExclusiveClaim,
  assertFailClosedStatuses,
  assertNoSecretFields,
  assertSourceOrder,
  checkThenSetAdmitsDoubleClaim,
} from "./pact.js";

describe("PACT helpers", () => {
  it("kills the check-then-set mutant and exclusive claim wins once", async () => {
    checkThenSetAdmitsDoubleClaim();
    const keys = new Set<string>();
    await assertExclusiveClaim(() => {
      if (keys.has("d1")) return false;
      keys.add("d1");
      return true;
    });
  });

  it("requires source-order markers and forbids secret fields", () => {
    assertSourceOrder("claim(); append(); rollback();", [
      "claim()",
      "append()",
      "rollback()",
    ]);
    expect(() =>
      assertSourceOrder("append(); claim();", ["claim()", "append()"]),
    ).toThrow(/missing append/);
    expect(() =>
      assertNoSecretFields({ ok: true, access_token: "x" }),
    ).toThrow(/access_token/);
    expect(() =>
      assertNoSecretFields({ ok: true, claimToken: "osc_clm_x" }, ["claimToken"]),
    ).not.toThrow();
    expect(() => assertNoSecretFields({ ok: true })).not.toThrow();
    assertFailClosedStatuses({ "200": {}, "401": {} }, ["401"]);
    expect(() => assertFailClosedStatuses({ "200": {} }, ["401"])).toThrow(
      /401/,
    );
  });

  it("caps concurrent wins and keeps durable work after a partition", async () => {
    let n = 0;
    const wins = await assertAtMostWins(() => {
      n += 1;
      return n <= 3;
    }, 3, 16);
    expect(wins).toBe(3);

    let durable = 1;
    await assertDurableSurvivesPartition(
      () => durable,
      async () => {
        throw new Error("bus down");
      },
    );
    await expect(
      assertDurableSurvivesPartition(
        () => 0,
        async () => {
          throw new Error("bus down");
        },
      ),
    ).rejects.toThrow(/dropped/);
  });
});

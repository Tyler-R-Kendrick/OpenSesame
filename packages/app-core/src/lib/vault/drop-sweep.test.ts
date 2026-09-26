import { type DropItem, createItem } from "@opensesame/vault-core";
import { describe, expect, it } from "vitest";
import { sweepDrops } from "./drop.js";

function consumed(): DropItem {
  return {
    ...createItem("drop", "Deploy token"),
    claimId: "clm_1",
    bearerToken: "osc_clm_clm_1.secret",
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    state: "consumed",
  };
}

describe("sweepDrops under a signal", () => {
  it("stops between drops once its signal aborts", async () => {
    const first = consumed();
    const second = consumed();
    const stop = new AbortController();
    const purged: string[] = [];
    await sweepDrops(
      [first, second],
      async (id) => {
        purged.push(id);
        stop.abort();
        await Promise.resolve();
      },
      stop.signal,
    );
    expect(purged).toEqual([first.id]);
  });
});

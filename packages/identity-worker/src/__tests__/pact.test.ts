import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRepositories } from "@opensesame/database";
import { fixtures } from "@opensesame/os-domain";
import {
  assertDurableSurvivesPartition,
  assertExclusiveClaim,
  assertNoSecretFields,
  assertSourceOrder,
} from "@opensesame/testing";
import { describe, expect, it } from "vitest";
import { createFakeClock, runCleanupTick } from "../cleanup.js";
import { MemoryTaskBus } from "../taskBus.js";

const here = dirname(fileURLToPath(import.meta.url));

describe("PACT — worker outbox drain", () => {
  it("claims before publish and releases on partition", () => {
    assertSourceOrder(readFileSync(join(here, "../cleanup.ts"), "utf8"), [
      "claimUnpublished",
      "taskBus.publish",
      "markPublished",
      "releaseClaim",
    ]);
  });

  it("keeps the outbox row when TaskBus is partitioned", async () => {
    const clock = createFakeClock(fixtures.now);
    const repos = createRepositories();
    await repos.outbox.append({
      id: "outbox_pact",
      aggregateType: "principal",
      aggregateId: "prn_pact",
      eventType: "principal.created",
      payload: {},
      availableAt: fixtures.now,
    });
    await assertDurableSurvivesPartition(
      async () => (await repos.outbox.listUnpublished()).length,
      async () => {
        await runCleanupTick({
          repos,
          clock: clock.asClock(),
          taskBus: {
            publish: async () => {
              throw new Error("nats down");
            },
          },
        });
      },
    );
  });

  it("claims unpublished rows exclusively", async () => {
    const repos = createRepositories();
    await repos.outbox.append({
      id: "outbox_excl",
      aggregateType: "principal",
      aggregateId: "prn_excl",
      eventType: "principal.created",
      payload: {},
      availableAt: new Date(),
    });
    const now = new Date();
    await assertExclusiveClaim(async () => {
      const claimed = await repos.outbox.claimUnpublished(1, now, 30_000);
      return claimed.length === 1;
    }, 16);
  });

  it("does not emit secret fields on a published CloudEvent", async () => {
    const clock = createFakeClock(fixtures.now);
    const repos = createRepositories();
    await repos.outbox.append({
      id: "outbox_contract",
      aggregateType: "principal",
      aggregateId: "prn_c",
      eventType: "principal.created",
      payload: { principalId: "prn_c" },
      availableAt: fixtures.now,
    });
    const bus = new MemoryTaskBus();
    await runCleanupTick({ repos, clock: clock.asClock(), taskBus: bus });
    expect(bus.published).toHaveLength(1);
    assertNoSecretFields(bus.published[0]);
  });
});

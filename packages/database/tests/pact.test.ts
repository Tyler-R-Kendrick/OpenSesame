import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertDurableSurvivesPartition,
  assertExclusiveClaim,
  assertNoSecretFields,
  assertSourceOrder,
} from "@opensesame/testing";
import { describe, expect, it } from "vitest";
import { createRepositories } from "../src/index.js";
import { withPostgresRepos } from "./pg-harness.js";

const here = dirname(fileURLToPath(import.meta.url));

describe("PACT — outbox claim", () => {
  it("memory claim hides the row from a second claimant", async () => {
    const repos = createRepositories();
    await repos.outbox.append({
      id: "outbox_pact",
      aggregateType: "principal",
      aggregateId: "prn_pact",
      eventType: "principal.created",
      payload: {},
    });
    const now = new Date();
    await assertExclusiveClaim(async () => {
      const claimed = await repos.outbox.claimUnpublished(1, now, 30_000);
      return claimed.length === 1;
    }, 16);
  });

  it("unpublished rows survive a failed mark after claim", async () => {
    const repos = createRepositories();
    await repos.outbox.append({
      id: "outbox_partition",
      aggregateType: "principal",
      aggregateId: "prn_part",
      eventType: "principal.created",
      payload: {},
    });
    const now = new Date();
    await assertDurableSurvivesPartition(
      async () => (await repos.outbox.listUnpublished()).length,
      async () => {
        const claimed = await repos.outbox.claimUnpublished(1, now, 30_000);
        expect(claimed).toHaveLength(1);
        const [row] = claimed;
        if (!row) throw new Error("missing claimed outbox row");
        await repos.outbox.releaseClaim(row.id, "nats down");
      },
    );
  });

  it("postgres claim uses SKIP LOCKED after selecting unpublished rows", () => {
    assertSourceOrder(
      readFileSync(join(here, "../src/repos/postgres.ts"), "utf8"),
      [
        "claimUnpublished",
        "outboxClaimToken",
        "skipLocked: true",
        "outboxHoldActive",
      ],
    );
  });

  it("outbox contract: claimed rows do not smuggle secret fields", async () => {
    const repos = createRepositories();
    await repos.outbox.append({
      id: "outbox_contract",
      aggregateType: "principal",
      aggregateId: "prn_contract",
      eventType: "principal.created",
      payload: { principalId: "prn_contract" },
    });
    const now = new Date();
    const claimed = await repos.outbox.claimUnpublished(1, now, 30_000);
    expect(claimed).toHaveLength(1);
    const [row] = claimed;
    if (!row) throw new Error("missing claimed outbox row");
    assertNoSecretFields(row);
    assertNoSecretFields(row.payload);
  });

  it("postgres SKIP LOCKED exclusive claim under concurrent drainers", async () => {
    await withPostgresRepos(async (repos) => {
      const id = `outbox_pact_pg_${randomUUID()}`;
      await repos.outbox.append({
        id,
        aggregateType: "principal",
        aggregateId: "prn_pact_pg",
        eventType: "principal.created",
        payload: {},
      });
      const now = new Date();
      await assertExclusiveClaim(async () => {
        const claimed = await repos.outbox.claimUnpublished(8, now, 30_000);
        return claimed.some((row) => row.id === id);
      }, 8);
    });
  });
});

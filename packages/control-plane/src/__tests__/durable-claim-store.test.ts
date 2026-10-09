import * as schema from "@opensesame/database/schema";
import { type ClaimSession, overlapCast } from "@opensesame/os-domain";
import { drizzle } from "drizzle-orm/pglite";
import { beforeAll, expect, it, vi } from "vitest";
import { DurableClaimStore } from "../repos/durable-claim-store.js";
import { migratedPGlite, warmMigratedPGlite } from "./migrated-pglite.js";

// Each PGlite test here starts its own database. They used to boot one and
// apply every migration inside the test, which on a loaded CI runner took most
// of the package's 15s budget (legacy-agent-durability timed out on it); now
// the migrations run once per file, in the hook below, and each test loads a
// copy (migrated-pglite.ts). The 60s budget stays as the margin for load.
vi.setConfig({ testTimeout: 60_000 });
beforeAll(warmMigratedPGlite, 60_000);

it("persists claim state and elects one CAS winner across instances", async () => {
  const client = await migratedPGlite();
  try {
    const db = drizzle(client, { schema });
    const first = new DurableClaimStore(overlapCast(db));
    const second = new DurableClaimStore(overlapCast(db));
    const claim: ClaimSession = {
      id: "durable-claim",
      type: "resource_bundle",
      state: "pending",
      tokenDigest: new Uint8Array([1, 2, 3]),
      targetManifest: {},
      targetManifestDigest: "sha256:test",
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60000),
      version: 1,
    };
    await first.create(claim, []);
    expect((await second.get(claim.id))?.version).toBe(1);
    const winners = await Promise.all(
      [first, second].map((store) =>
        store.compareAndSwap(claim.id, 1, {
          ...claim,
          state: "denied",
          version: 2,
        }),
      ),
    );
    expect(winners.filter(({ won }) => won)).toHaveLength(1);
    expect(
      (await new DurableClaimStore(overlapCast(db)).get(claim.id))?.state,
    ).toBe("denied");
  } finally {
    await client.close();
  }
});

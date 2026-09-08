import { PGlite } from "@electric-sql/pglite";
import * as schema from "@opensesame/database/schema";
import { overlapCast } from "@opensesame/os-domain";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { expect, it } from "vitest";
import { DurableMap } from "../repos/durable-map.js";

it("shares exact typed state, hashes bearer keys, and consumes once across replicas", async () => {
  const client = new PGlite();
  try {
    const db = drizzle(client, { schema });
    await migrate(db, {
      migrationsFolder: new URL(
        "../../../../packages/database/drizzle",
        import.meta.url,
      ).pathname,
    });
    const first = new DurableMap<{ expiresAt: Date; proof: Uint8Array }>(
      overlapCast(db),
      "OpenSesame:Test",
      true,
    );
    const second = new DurableMap<{ expiresAt: Date; proof: Uint8Array }>(
      overlapCast(db),
      "OpenSesame:Test",
      true,
    );
    const token = "pst_test-only-private-token";
    const record = {
      expiresAt: new Date(Date.now() + 60000),
      proof: new Uint8Array([1, 2]),
    };
    await first.set(token, record);
    expect(await second.get(token)).toEqual(record);
    expect(
      JSON.stringify(await db.select().from(schema.oidcPayloads)),
    ).not.toContain(token);
    const claimed = await Promise.all([first.take(token), second.take(token)]);
    expect(claimed.filter(Boolean)).toHaveLength(1);
    await first.set(token, {
      ...record,
      expiresAt: new Date(Date.now() - 1000),
    });
    expect(await second.get(token)).toBeUndefined();
    expect(await second.take(token)).toBeUndefined();
    await first.set(token, record);
    for (const [key] of await second.entries()) {
      expect(await second.delete(`stored-digest:${key}`)).toBe(false);
      expect(await second.delete(key)).toBe(false);
      await second.deleteEntry(key);
    }
    expect(await first.get(token)).toBeUndefined();
    const bounded = () =>
      new DurableMap<{ expiresAt: Date }>(
        overlapCast(db),
        "OpenSesame:Bounded",
        false,
        60_000,
        2,
      );
    const capacityResults = await Promise.allSettled(
      ["a", "b", "c"].map((key) =>
        bounded().claim(key, { expiresAt: record.expiresAt }),
      ),
    );
    expect(
      capacityResults.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(2);
    await bounded().set("a", { expiresAt: new Date(Date.now() - 1000) });
    expect(await bounded().claim("a", { expiresAt: record.expiresAt })).toBe(
      true,
    );
    expect(await bounded().claim("a", { expiresAt: record.expiresAt })).toBe(
      false,
    );
    expect(() => new DurableMap(overlapCast(db), "Session")).toThrow();
    const race = new DurableMap<number>(
      overlapCast(db),
      "OpenSesame:MutationRace",
    );
    for (let attempt = 0; attempt < 10; attempt++) {
      await race.set("counter", 1);
      await Promise.all([
        race.update("counter", (value) => (value ?? 0) + 1),
        race.set("counter", 100),
      ]);
      expect(await race.get("counter")).toBeGreaterThanOrEqual(100);
    }
  } finally {
    await client.close();
  }
});

it("preserves numeric expiry and refuses non-string persisted envelopes", async () => {
  const client = new PGlite();
  try {
    const db = drizzle(client, { schema });
    await migrate(db, {
      migrationsFolder: new URL(
        "../../../../packages/database/drizzle",
        import.meta.url,
      ).pathname,
    });
    const model = "OpenSesame:EnvelopeBoundary";
    const store = new DurableMap<{ expiresAt: number }>(overlapCast(db), model);
    await store.set("expired", { expiresAt: Date.now() - 1000 });
    expect(await store.get("expired")).toBeUndefined();
    const live = { expiresAt: Date.now() + 60000 };
    await store.set("live", live);
    expect(await store.get("live")).toEqual(live);
    await db
      .insert(schema.oidcPayloads)
      .values({ model, id: "malformed", payload: { value: 42 } });
    await expect(store.get("malformed")).rejects.toThrow(
      "Invalid durable security record",
    );
  } finally {
    await client.close();
  }
});

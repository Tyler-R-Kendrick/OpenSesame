import { createHash } from "node:crypto";
import { serialize } from "node:v8";
import {
  createEventSealer,
  oidcLookup,
  sealLegacyOidc,
  sealOidcRow,
} from "@opensesame/database";
import * as schema from "@opensesame/database/schema";
import { overlapCast } from "@opensesame/os-domain";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { beforeAll, expect, it, vi } from "vitest";
import { DurableMap } from "../repos/durable-map.js";
import { migratedPGlite, warmMigratedPGlite } from "./migrated-pglite.js";

// Each PGlite test here starts its own database. They used to boot one and
// apply every migration inside the test, which on a loaded CI runner took most
// of the package's 15s budget (legacy-agent-durability timed out on it); now
// the migrations run once per file, in the hook below, and each test loads a
// copy (migrated-pglite.ts). The 60s budget stays as the margin for load.
vi.setConfig({ testTimeout: 60_000 });
beforeAll(warmMigratedPGlite, 60_000);

it("shares exact typed state, hashes bearer keys, and consumes once across replicas", async () => {
  const client = await migratedPGlite();
  try {
    const db = drizzle(client, { schema });
    const first = new DurableMap<{ expiresAt: Date; proof: Uint8Array }>(
      overlapCast(db),
      "OpenSesame:Test",
      true,
      undefined,
      undefined,
      createEventSealer("durable-security-fixture-key"),
    );
    const second = new DurableMap<{ expiresAt: Date; proof: Uint8Array }>(
      overlapCast(db),
      "OpenSesame:Test",
      true,
      undefined,
      undefined,
      createEventSealer("durable-security-fixture-key"),
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
        createEventSealer("durable-security-fixture-key"),
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
    expect(
      () =>
        new DurableMap(
          overlapCast(db),
          "Session",
          undefined,
          undefined,
          undefined,
          createEventSealer("durable-security-fixture-key"),
        ),
    ).toThrow();
    const race = new DurableMap<number>(
      overlapCast(db),
      "OpenSesame:MutationRace",
      undefined,
      undefined,
      undefined,
      createEventSealer("durable-security-fixture-key"),
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
  const client = await migratedPGlite();
  try {
    const db = drizzle(client, { schema });
    const model = "OpenSesame:EnvelopeBoundary";
    const store = new DurableMap<{ expiresAt: number }>(
      overlapCast(db),
      model,
      undefined,
      undefined,
      undefined,
      createEventSealer("durable-security-fixture-key"),
    );
    await store.set("expired", { expiresAt: Date.now() - 1000 });
    expect(await store.get("expired")).toBeUndefined();
    const live = { expiresAt: Date.now() + 60000 };
    await store.set("live", live);
    expect(await store.get("live")).toEqual(live);
    await db
      .insert(schema.oidcPayloads)
      .values(
        sealOidcRow(
          createEventSealer("durable-security-fixture-key"),
          model,
          "malformed",
          { value: 42 },
        ),
      );
    await expect(store.get("malformed")).rejects.toThrow(
      "Invalid durable security record",
    );
  } finally {
    await client.close();
  }
});

it("migrates legacy TOTP and prehashed provisional tokens into owner-bound envelopes", async () => {
  const client = await migratedPGlite();
  try {
    const db = drizzle(client, { schema });
    const sealer = createEventSealer("durable-security-fixture-key");
    const principalId = "principal-customer-a";
    const totp = "totp-private-seed";
    const token = "pst_legacy-private-bearer";
    const sessionId = "private-provisional-session";
    await db.insert(schema.oidcPayloads).values([
      {
        model: "OpenSesame:TotpSecret",
        id: principalId,
        payload: { value: serialize(totp).toString("base64") },
      },
      {
        model: "OpenSesame:ProvisionalToken",
        id: createHash("sha256").update(token).digest("hex"),
        payload: { value: serialize(sessionId).toString("base64") },
      },
      {
        model: "OpenSesame:ProvisionalSession",
        id: sessionId,
        payload: { value: serialize({ principalId }).toString("base64") },
      },
    ]);
    expect(await sealLegacyOidc(overlapCast(db), sealer)).toBe(3);
    expect(await sealLegacyOidc(overlapCast(db), sealer)).toBe(0);
    const secrets = new DurableMap<string>(
      overlapCast(db),
      "OpenSesame:TotpSecret",
      false,
      null,
      undefined,
      sealer,
    );
    const tokens = new DurableMap<string>(
      overlapCast(db),
      "OpenSesame:ProvisionalToken",
      true,
      undefined,
      undefined,
      sealer,
    );
    expect(await secrets.get(principalId)).toBe(totp);
    expect(await tokens.get(token)).toBe(sessionId);
    const [row] = await db
      .select()
      .from(schema.oidcPayloads)
      .where(eq(schema.oidcPayloads.model, "OpenSesame:TotpSecret"));
    expect(row?.sealScope).toContain(principalId);
    const dump = JSON.stringify(await db.select().from(schema.oidcPayloads));
    for (const secret of [totp, token, sessionId])
      expect(dump).not.toContain(secret);
    const claimed = await Promise.all([tokens.take(token), tokens.take(token)]);
    expect(claimed.filter(Boolean)).toEqual([sessionId]);
    if (!row) throw new Error("Missing TOTP envelope");
    await db.insert(schema.oidcPayloads).values({
      ...row,
      id: oidcLookup(
        sealer,
        "OpenSesame:TotpSecret",
        "id",
        "principal-customer-b",
      ),
    });
    await expect(secrets.get("principal-customer-b")).rejects.toThrow();
  } finally {
    await client.close();
  }
});

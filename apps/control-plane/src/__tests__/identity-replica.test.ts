import { PGlite } from "@electric-sql/pglite";
import { createPasskeySeam } from "@opensesame/auth-upstream";
import * as schema from "@opensesame/database/schema";
import { overlapCast } from "@opensesame/os-domain";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { expect, it } from "vitest";
import { createControlPlane } from "../create-app.js";
import { DurableMap, incrementSecurityCounter } from "../repos/durable-map.js";
import { durablePasskeyCredentials } from "../repos/durable-passkey-store.js";

it("shares sessions/revocation and atomic passkey/counter state across app instances", async () => {
  const client = new PGlite();
  try {
    const db = drizzle(client, { schema });
    await migrate(db, {
      migrationsFolder: new URL(
        "../../../../packages/database/drizzle",
        import.meta.url,
      ).pathname,
    });
    const options = {
      database: overlapCast(db),
      config: { claimPepper: "replica-test-only-claim-pepper-32chars" },
    };
    const first = createControlPlane(options);
    const second = createControlPlane(options);
    await Promise.all([
      first.ctx.systemPrincipalReady,
      second.ctx.systemPrincipalReady,
    ]);
    const minted = await first.app.request("/v1/principals/provisional", {
      method: "POST",
    });
    expect(minted.status).toBe(201);
    const body = await minted.json();
    const headers = { authorization: `Bearer ${body.accessToken}` };
    expect(
      (await second.app.request("/v1/principals/me", { headers })).status,
    ).toBe(200);
    expect(
      (
        await second.app.request("/v1/principals/provisional/revoke", {
          method: "POST",
          headers,
        })
      ).status,
    ).toBe(204);
    expect(
      (await first.app.request("/v1/principals/me", { headers })).status,
    ).toBe(401);
    const counters = [1, 2].map(
      () => new DurableMap<number>(overlapCast(db), "OpenSesame:CounterTest"),
    );
    expect(
      (
        await Promise.all(
          counters.map((store) => incrementSecurityCounter(store, "attempt")),
        )
      ).sort(),
    ).toEqual([1, 2]);
    const makeSeam = () =>
      createPasskeySeam({
        credentialStore: durablePasskeyCredentials(overlapCast(db)),
        verifyAssertion: async () => ({ ok: true, newCounter: 2 }),
      });
    const a = makeSeam();
    const b = makeSeam();
    const credential = {
      credentialId: "replica-key",
      publicKey: new Uint8Array([1]),
      counter: 1,
    };
    await a.register(body.principalId, credential);
    await expect(b.register("different-owner", credential)).rejects.toThrow(
      /already registered/,
    );
    const assertion = {
      credentialId: credential.credentialId,
      clientDataJSON: new Uint8Array(),
      authenticatorData: new Uint8Array(),
      signature: new Uint8Array(),
    };
    const results = await Promise.all([
      a.verify(assertion),
      b.verify(assertion),
    ]);
    expect(results.filter(({ ok }) => ok)).toHaveLength(1);
    const replay = {
      id: "oidc-logout:test-digest",
      providerId: "oidc-logout",
      callbackDigest: "test-digest",
      seenAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    };
    expect(await first.ctx.repos.callbackReplays.claim(replay)).toBe(true);
    expect(await second.ctx.repos.callbackReplays.claim(replay)).toBe(false);
    await client.exec("DROP TABLE oidc_payloads");
    expect((await first.app.request("/v1/health/ready")).status).toBe(503);
    expect((await first.app.request("/v1/health/live")).status).toBe(200);
  } finally {
    await client.close();
  }
});

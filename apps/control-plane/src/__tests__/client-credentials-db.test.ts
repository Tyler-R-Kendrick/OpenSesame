import { PGlite } from "@electric-sql/pglite";
import * as schema from "@opensesame/database/schema";
import { overlapCast } from "@opensesame/os-domain";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { startServer } from "../server.js";
import {
  ccBody,
  clientAssertion,
  postToken,
  rsaPair,
} from "./cc-token-helpers.js";
import { onFreePort } from "./free-port.js";

type Started = Awaited<ReturnType<typeof startServer>>;

const MIGRATIONS = new URL(
  "../../../../packages/database/drizzle",
  import.meta.url,
).pathname;

async function verified(app: Started["app"], subject: string) {
  const minted = await app.request("/v1/principals/provisional", {
    method: "POST",
  });
  const body = overlapCast(await minted.json());
  expect(
    (
      await app.request("/v1/principals/link-identities", {
        method: "POST",
        headers: {
          authorization: `Bearer ${body.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          kind: "oidc",
          issuer: "https://mock.example",
          subject,
          assurance: "verified",
        }),
      })
    ).status,
  ).toBe(201);
  return body;
}

describe("Identity /token client_credentials on Postgres", () => {
  let pg: PGlite;
  let started: Started;
  let base: string;
  let tokenUrl: string;

  beforeAll(async () => {
    pg = new PGlite();
    const db = drizzle(pg, { schema });
    await migrate(db, { migrationsFolder: MIGRATIONS });
    const { startServer: start } = await import("../server.js");
    started = await onFreePort((port) =>
      start({
        database: overlapCast(db),
        config: {
          host: "127.0.0.1",
          port,
          publicUrl: `http://127.0.0.1:${port}`,
          issuer: `http://127.0.0.1:${port}`,
        },
      }),
    );
    base = `http://127.0.0.1:${started.port}`;
    tokenUrl = `${base}/token`;
  }, 60_000);

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      started.server.close((err) => (err ? reject(err) : resolve()));
    });
    await pg.close();
  });

  it("mints, denies public/wrong-key/replay, retires old JWKS, and suspends", async () => {
    const current = rsaPair("cc-db-1");
    const other = rsaPair("cc-db-wrong");
    const owner = await verified(started.app, "cc-db-owner");
    const created = await started.app.request("/v1/oauth/clients", {
      method: "POST",
      headers: {
        authorization: `Bearer ${owner.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        displayName: "Workload",
        redirectUris: ["https://workload.example/cb"],
        sectorIdentifier: "https://workload-db.example",
        grantTypes: ["client_credentials"],
        responseTypes: [],
        tokenEndpointAuthMethod: "private_key_jwt",
        jwks: { keys: [current.jwk] },
      }),
    });
    expect(created.status).toBe(201);
    const client = overlapCast(await created.json());
    const stored = await started.ctx.oauth.clientStore.findById(
      String(client.id),
    );
    expect(stored?.jwks?.keys[0]?.kid).toBe("cc-db-1");

    const mint = await postToken(
      tokenUrl,
      ccBody(
        String(client.id),
        clientAssertion(
          current.privateKey,
          "cc-db-1",
          String(client.id),
          base,
          "jti-db-1",
        ),
      ),
    );
    expect(mint.status).toBe(200);
    expect(mint.json.access_token).toEqual(expect.any(String));
    expect(mint.json.id_token).toBeUndefined();
    expect(mint.json.refresh_token).toBeUndefined();
    expect(mint.json.expires_in).toBeLessThanOrEqual(3600);

    const publicDenied = await postToken(
      tokenUrl,
      new URLSearchParams({
        grant_type: "client_credentials",
        client_id: "spa-public",
      }),
    );
    expect(publicDenied.status).toBeGreaterThanOrEqual(400);
    expect(publicDenied.json.access_token).toBeUndefined();

    const wrongKey = await postToken(
      tokenUrl,
      ccBody(
        String(client.id),
        clientAssertion(
          other.privateKey,
          "cc-db-1",
          String(client.id),
          base,
          "jti-wrong",
        ),
      ),
    );
    expect(wrongKey.status).toBeGreaterThanOrEqual(400);
    expect(wrongKey.json.access_token).toBeUndefined();

    const replayBody = ccBody(
      String(client.id),
      clientAssertion(
        current.privateKey,
        "cc-db-1",
        String(client.id),
        base,
        "jti-replay",
      ),
    );
    expect((await postToken(tokenUrl, replayBody)).status).toBe(200);
    const replayed = await postToken(tokenUrl, replayBody);
    expect(replayed.status).toBeGreaterThanOrEqual(400);
    expect(replayed.json.access_token).toBeUndefined();

    const next = rsaPair("cc-db-2");
    const rotated = await started.app.request(
      `/v1/oauth/clients/${client.id}`,
      {
        method: "PATCH",
        headers: {
          authorization: `Bearer ${owner.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ jwks: { keys: [next.jwk] } }),
      },
    );
    expect(rotated.status).toBe(200);
    const retired = await postToken(
      tokenUrl,
      ccBody(
        String(client.id),
        clientAssertion(
          current.privateKey,
          "cc-db-1",
          String(client.id),
          base,
          "jti-old",
        ),
      ),
    );
    expect(retired.status).toBeGreaterThanOrEqual(400);
    expect(retired.json.access_token).toBeUndefined();
    const fresh = await postToken(
      tokenUrl,
      ccBody(
        String(client.id),
        clientAssertion(
          next.privateKey,
          "cc-db-2",
          String(client.id),
          base,
          "jti-new",
        ),
      ),
    );
    expect(fresh.status).toBe(200);

    const suspended = await started.app.request(
      `/v1/oauth/clients/${client.id}`,
      {
        method: "PATCH",
        headers: {
          authorization: `Bearer ${owner.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ state: "suspended" }),
      },
    );
    expect(suspended.status).toBe(200);
    const afterSuspend = await postToken(
      tokenUrl,
      ccBody(
        String(client.id),
        clientAssertion(
          next.privateKey,
          "cc-db-2",
          String(client.id),
          base,
          "jti-sus",
        ),
      ),
    );
    expect(afterSuspend.status).toBeGreaterThanOrEqual(400);
    expect(afterSuspend.json.access_token).toBeUndefined();
  }, 60_000);
});

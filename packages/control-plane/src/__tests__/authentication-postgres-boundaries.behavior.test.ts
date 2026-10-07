import * as schema from "@opensesame/database/schema";
import { overlapCast } from "@opensesame/os-domain";
import { drizzle } from "drizzle-orm/pglite";
import { beforeAll, expect, it } from "vitest";
import { createControlPlane } from "../create-app.js";
import { verifiedPrincipal } from "./authentication-fixture.js";
import { error, request, seedUser } from "./authentication-http-fixture.js";
import {
  enrolledCredential,
  exchange,
  optionsFor,
  verify,
} from "./authentication-signed.test-support.js";
import { migratedPGlite, warmMigratedPGlite } from "./migrated-pglite.js";

// Use the existing migrated PGlite fixture and its existing 60-second setup
// budget. Individual cases retain the package's normal 15-second limit.
beforeAll(warmMigratedPGlite, 60_000);

async function replicas() {
  const client = await migratedPGlite();
  try {
    const db = drizzle(client, { schema });
    const open = async () => {
      const plane = createControlPlane({
        database: overlapCast(db),
        processEnv: { NODE_ENV: "test", OPENSESAME_ALLOW_DEV_DEFAULTS: "1" },
        config: {
          port: 0,
          publicUrl: "http://127.0.0.1:8788",
          issuer: "http://127.0.0.1:8788",
          claimPepper: "authentication-replica-fixture-key-32characters",
        },
      });
      await plane.ctx.systemPrincipalReady;
      return plane;
    };
    const first = await open();
    const second = await open();
    const owner = await verifiedPrincipal(first.app);
    const created = await request(
      first,
      "/v1/authentication/applications",
      owner.auth,
      "POST",
      {
        displayName: "Replica application",
        rpId: "localhost",
        origins: ["http://localhost:5180"],
      },
    );
    expect(created.status).toBe(201);
    const body: { application: { id: string }; apiSecret: string } =
      overlapCast(await created.json());
    const id = body.application.id;
    const f = {
      plane: first,
      owner: owner.auth,
      id,
      secret: body.apiSecret,
      backend: { authorization: `Bearer ${body.apiSecret}` },
      root: `/v1/authentication/applications/${id}`,
    };
    await seedUser(first, id);
    const signer = await enrolledCredential(f);
    return { client, f, peer: { ...f, plane: second }, signer };
  } catch (error) {
    await client.close();
    throw error;
  }
}

it("honors a peer's durable secret rotation and credential revocation on both real HTTP applications", async () => {
  const { client, f, peer, signer } = await replicas();
  try {
    const original = await peer.plane.ctx.authenticationStores.credentials.get(
      f.id,
      signer.credentialId,
    );
    expect(original).toMatchObject({ counter: 0 });
    const outstanding = await optionsFor(f);
    const rotated = await request(f.plane, `${f.root}/rotate-secret`, f.owner);
    expect(rotated.status).toBe(200);
    const replacement: { apiSecret: string } = overlapCast(
      await rotated.json(),
    );
    expect(replacement.apiSecret).not.toBe(f.secret);
    const deletePath = "/v1/authentication/backend/credentials/delete";
    const body = { applicationId: f.id, credentialId: signer.credentialId };
    await error(
      await request(peer.plane, deletePath, f.backend, "POST", body),
      401,
      "unauthorized",
    );
    expect(
      await f.plane.ctx.authenticationStores.credentials.get(
        f.id,
        signer.credentialId,
      ),
    ).toEqual(original);
    const backend = { authorization: `Bearer ${replacement.apiSecret}` };
    const listed = await request(
      peer.plane,
      "/v1/authentication/backend/credentials/list",
      backend,
      "POST",
      { applicationId: f.id, userId: "fixture-user" },
    );
    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject({
      credentials: [{ credentialId: signer.credentialId }],
    });
    expect(
      (await request(peer.plane, deletePath, backend, "POST", body)).status,
    ).toBe(204);
    expect(
      await f.plane.ctx.authenticationStores.credentials.get(
        f.id,
        signer.credentialId,
      ),
    ).toBeUndefined();
    await error(
      await verify(f, signer.assertion(outstanding.challenge)),
      404,
      "unknown_credential",
    );
    await error(
      await request(f.plane, deletePath, backend, "POST", body),
      404,
      "not_found",
    );
    expect(
      await (
        await request(
          f.plane,
          "/v1/authentication/backend/credentials/list",
          backend,
          "POST",
          { applicationId: f.id, userId: "fixture-user" },
        )
      ).json(),
    ).toEqual({ credentials: [] });
  } finally {
    await client.close();
  }
});

it("verifies a genuine signature across instances and atomically spends its durable token once", async () => {
  const { client, f, peer, signer } = await replicas();
  try {
    const options = await optionsFor(f);
    const authenticated = await verify(
      peer,
      signer.assertion(options.challenge),
    );
    expect(authenticated.status).toBe(200);
    const issued: { token: string } = overlapCast(await authenticated.json());
    expect(issued.token).toMatch(/^ost_/);
    expect(
      await f.plane.ctx.authenticationStores.credentials.get(
        f.id,
        signer.credentialId,
      ),
    ).toMatchObject({ counter: 1 });
    const attempts = await Promise.all([
      exchange(f, issued.token),
      exchange(peer, issued.token),
    ]);
    expect(attempts.map((result) => result.status).sort()).toEqual([200, 403]);
    const success = attempts.find((result) => result.status === 200);
    if (!success)
      throw new Error("genuine token positive control did not complete");
    expect(await success.json()).toEqual({
      success: true,
      userId: "fixture-user",
      purpose: "step-up",
      type: "passkey",
      aliases: [],
    });
    for (const result of attempts.filter(
      (response) => response.status === 403,
    )) {
      expect(await result.json()).toMatchObject({ error: "invalid_token" });
    }
    await error(await exchange(f, issued.token), 403, "invalid_token");
    const replay = await optionsFor(peer);
    await error(
      await verify(f, signer.assertion(replay.challenge)),
      400,
      "invalid_response",
    );
    expect(
      await peer.plane.ctx.authenticationStores.credentials.get(
        f.id,
        signer.credentialId,
      ),
    ).toMatchObject({ counter: 1 });
  } finally {
    await client.close();
  }
});

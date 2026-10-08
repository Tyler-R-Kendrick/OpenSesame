import { overlapCast } from "@opensesame/os-domain";
import { expect, it } from "vitest";
import { error, request } from "./authentication-http-fixture.js";
import {
  optionsFor,
  signedFixture,
  verify,
} from "./authentication-signed.test-support.js";

it("renames and clears only an owned credential without altering its signing material", async () => {
  const f = await signedFixture();
  const credentialId = f.signer.credentialId;
  const path = `${f.root}/credentials/${credentialId}`;
  const before = await f.plane.ctx.authenticationStores.credentials.get(
    f.id,
    credentialId,
  );
  const foreign = await f.plane.app.request("/v1/principals/provisional", {
    method: "POST",
  });
  expect(foreign.status).toBe(201);
  const guest: { accessToken: string } = overlapCast(await foreign.json());
  await error(
    await request(
      f.plane,
      path,
      { authorization: `Bearer ${guest.accessToken}` },
      "PATCH",
      { name: "Stolen" },
    ),
    404,
    "not_found",
  );
  await error(
    await request(f.plane, path, f.owner, "PATCH", { name: " " }),
    400,
    "validation_error",
  );
  expect(
    await f.plane.ctx.authenticationStores.credentials.get(f.id, credentialId),
  ).toEqual(before);
  expect(
    (await request(f.plane, path, f.owner, "PATCH", { name: "  Office key  " }))
      .status,
  ).toBe(200);
  const renamed = await f.plane.ctx.authenticationStores.credentials.get(
    f.id,
    credentialId,
  );
  expect(renamed).toMatchObject({ name: "Office key", counter: 0 });
  expect(renamed?.publicKey).toEqual(before?.publicKey);
  expect(
    (await request(f.plane, path, f.owner, "PATCH", { name: null })).status,
  ).toBe(200);
  const cleared = await f.plane.ctx.authenticationStores.credentials.get(
    f.id,
    credentialId,
  );
  expect(cleared).not.toHaveProperty("name");
  expect(cleared?.publicKey).toEqual(before?.publicKey);
  const options = await optionsFor(f);
  expect((await verify(f, f.signer.assertion(options.challenge))).status).toBe(
    200,
  );
  await error(
    await request(f.plane, `${f.root}/credentials/missing`, f.owner, "PATCH", {
      name: "Absent",
    }),
    404,
    "not_found",
  );
});

it("redacts credential material in owner and backend inventories and honors backend revocation", async () => {
  const f = await signedFixture();
  const users = await request(f.plane, `${f.root}/users`, f.owner, "GET");
  expect(users.status).toBe(200);
  const body: { users: { credentials: Record<string, unknown>[] }[] } =
    overlapCast(await users.json());
  expect(body).toMatchObject({
    users: [
      {
        userId: "fixture-user",
        credentials: [
          {
            credentialId: f.signer.credentialId,
            name: null,
            lastUsedAt: null,
          },
        ],
      },
    ],
  });
  const firstUser = body.users[0];
  if (!firstUser) throw new Error("owner user inventory missing fixture");
  expect(firstUser.credentials[0]).not.toHaveProperty("publicKey");
  const listPath = "/v1/authentication/backend/credentials/list";
  const list = await request(f.plane, listPath, f.backend, "POST", {
    applicationId: f.id,
    userId: "fixture-user",
  });
  expect(list.status).toBe(200);
  const listed: { credentials: Record<string, unknown>[] } = overlapCast(
    await list.json(),
  );
  expect(listed.credentials).toHaveLength(1);
  expect(listed.credentials[0]).toMatchObject({
    credentialId: f.signer.credentialId,
    signatureCounter: 0,
    nickname: null,
    transports: ["internal"],
    rpId: "localhost",
    lastUsedAt: null,
  });
  expect(listed.credentials[0]).not.toHaveProperty("publicKey");
  await error(
    await request(f.plane, listPath, f.backend, "POST", {
      applicationId: f.id,
      userId: "missing-user",
    }),
    404,
    "unknown_credential",
  );
  const outstanding = await optionsFor(f);
  const deletion = "/v1/authentication/backend/credentials/delete";
  await error(
    await request(f.plane, deletion, {}, "POST", {
      applicationId: f.id,
      credentialId: f.signer.credentialId,
    }),
    401,
    "unauthorized",
  );
  expect(
    (
      await request(f.plane, deletion, f.backend, "POST", {
        applicationId: f.id,
        credentialId: f.signer.credentialId,
      })
    ).status,
  ).toBe(204);
  expect(
    await f.plane.ctx.authenticationStores.credentials.get(
      f.id,
      f.signer.credentialId,
    ),
  ).toBeUndefined();
  await error(
    await verify(f, f.signer.assertion(outstanding.challenge)),
    404,
    "unknown_credential",
  );
  await error(
    await request(f.plane, deletion, f.backend, "POST", {
      applicationId: f.id,
      credentialId: f.signer.credentialId,
    }),
    404,
    "not_found",
  );
  expect(
    await (
      await request(f.plane, listPath, f.backend, "POST", {
        applicationId: f.id,
        userId: "fixture-user",
      })
    ).json(),
  ).toEqual({ credentials: [] });
});

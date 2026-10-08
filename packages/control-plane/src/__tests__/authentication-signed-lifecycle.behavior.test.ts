import { overlapCast } from "@opensesame/os-domain";
import { expect, it } from "vitest";
import { ORIGIN, error, request } from "./authentication-http-fixture.js";
import {
  enrolledCredential,
  exchange,
  optionsFor,
  signedFixture,
  verify,
} from "./authentication-signed.test-support.js";

type Issued = { token: string; expiresAt: string };

it.each(["discoverable", "autofill", "alias", "user_id"])(
  "verifies a genuine signed %s step-up and exchanges its token once",
  async (mode) => {
    const f = await signedFixture();
    expect(
      (
        await request(
          f.plane,
          "/v1/authentication/backend/aliases",
          f.backend,
          "POST",
          {
            applicationId: f.id,
            userId: "fixture-user",
            aliases: ["Owner@Example.Test"],
            hashing: true,
          },
        )
      ).status,
    ).toBe(204);
    const options = await optionsFor(f, {
      mode,
      alias: "owner@example.test",
      userId: "fixture-user",
    });
    if (mode === "alias" || mode === "user_id") {
      expect(options.allowCredentials?.map((row) => row.id)).toEqual([
        f.signer.credentialId,
      ]);
    }
    const accepted = await verify(f, f.signer.assertion(options.challenge));
    expect(accepted.status).toBe(200);
    const issued: Issued = overlapCast(await accepted.json());
    expect(issued.token).toMatch(/^ost_/);
    const credential = await f.plane.ctx.authenticationStores.credentials.get(
      f.id,
      f.signer.credentialId,
    );
    expect(credential).toMatchObject({ counter: 1 });
    expect(credential?.lastUsedAt).toBeInstanceOf(Date);
    const result = await exchange(f, issued.token);
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({
      success: true,
      userId: "fixture-user",
      purpose: "step-up",
      type: "passkey",
      aliases: [],
    });
    await error(await exchange(f, issued.token), 403, "invalid_token");
  },
);

it.each([
  ["foreign origin", { origin: "https://foreign.example" }],
  ["missing UV", { flags: 0x01 }],
] as const)(
  "rejects a cryptographically signed assertion with %s without recording use",
  async (_label, change) => {
    const f = await signedFixture();
    const before = await f.plane.ctx.authenticationStores.credentials.get(
      f.id,
      f.signer.credentialId,
    );
    const options = await optionsFor(f);
    await error(
      await verify(f, f.signer.assertion(options.challenge, change)),
      400,
      "invalid_response",
    );
    expect(
      await f.plane.ctx.authenticationStores.credentials.get(
        f.id,
        f.signer.credentialId,
      ),
    ).toEqual(before);
    await error(
      await verify(f, f.signer.assertion(options.challenge)),
      400,
      "invalid_response",
    );
    const fresh = await optionsFor(f);
    expect((await verify(f, f.signer.assertion(fresh.challenge))).status).toBe(
      200,
    );
  },
);

it("refuses replayed counters but permits a fresh increasing signed counter", async () => {
  const f = await signedFixture();
  const first = await optionsFor(f);
  expect((await verify(f, f.signer.assertion(first.challenge))).status).toBe(
    200,
  );
  const before = await f.plane.ctx.authenticationStores.credentials.get(
    f.id,
    f.signer.credentialId,
  );
  const replay = await optionsFor(f);
  await error(
    await verify(f, f.signer.assertion(replay.challenge)),
    400,
    "invalid_response",
  );
  expect(
    await f.plane.ctx.authenticationStores.credentials.get(
      f.id,
      f.signer.credentialId,
    ),
  ).toEqual(before);
  const fresh = await optionsFor(f);
  expect(
    (await verify(f, f.signer.assertion(fresh.challenge, { counter: 2 })))
      .status,
  ).toBe(200);
  expect(
    await f.plane.ctx.authenticationStores.credentials.get(
      f.id,
      f.signer.credentialId,
    ),
  ).toMatchObject({ counter: 2 });
});

it("expires an actual challenge without changing the key and admits a newly issued one", async () => {
  let now = Date.parse("2026-10-07T12:00:00Z");
  const f = await signedFixture(() => new Date(now));
  const options = await optionsFor(f);
  const before = await f.plane.ctx.authenticationStores.credentials.get(
    f.id,
    f.signer.credentialId,
  );
  now += 5 * 60_000;
  await error(
    await verify(f, f.signer.assertion(options.challenge)),
    400,
    "invalid_response",
  );
  expect(
    await f.plane.ctx.authenticationStores.credentials.get(
      f.id,
      f.signer.credentialId,
    ),
  ).toEqual(before);
  const fresh = await optionsFor(f);
  expect((await verify(f, f.signer.assertion(fresh.challenge))).status).toBe(
    200,
  );
});

it("binds the real challenge to the selected user even when the other user's signature is valid", async () => {
  const f = await signedFixture();
  const now = f.plane.ctx.clock();
  await f.plane.ctx.authenticationStores.users.put(
    {
      applicationId: f.id,
      userId: "other",
      userName: "Other",
      displayName: "Other",
      createdAt: now,
      updatedAt: now,
    },
    [],
  );
  const other = await enrolledCredential(f, "other");
  const selected = await optionsFor(f);
  await error(
    await verify(f, other.assertion(selected.challenge)),
    404,
    "unknown_credential",
  );
  expect(
    await f.plane.ctx.authenticationStores.credentials.get(
      f.id,
      other.credentialId,
    ),
  ).toMatchObject({ counter: 0 });
  const fresh = await optionsFor(f, { mode: "user_id", userId: "other" });
  expect((await verify(f, other.assertion(fresh.challenge))).status).toBe(200);
});

it("allows only one concurrent spend of the same signed challenge and one token exchange", async () => {
  const f = await signedFixture();
  const options = await optionsFor(f);
  const assertion = f.signer.assertion(options.challenge);
  const attempts = await Promise.all([
    verify(f, assertion),
    verify(f, assertion),
  ]);
  expect(attempts.map((response) => response.status).sort()).toEqual([
    200, 400,
  ]);
  const winner = attempts.find((response) => response.status === 200);
  if (!winner) throw new Error("signed positive control did not complete");
  const issued: Issued = overlapCast(await winner.json());
  const exchanges = await Promise.all([
    exchange(f, issued.token),
    exchange(f, issued.token),
  ]);
  expect(exchanges.map((response) => response.status).sort()).toEqual([
    200, 403,
  ]);
  expect(
    await f.plane.ctx.authenticationStores.credentials.get(
      f.id,
      f.signer.credentialId,
    ),
  ).toMatchObject({ counter: 1 });
});

it("refuses a registration-purpose challenge as an authentication proof", async () => {
  const f = await signedFixture();
  const minted = await request(
    f.plane,
    "/v1/authentication/backend/registration-tokens",
    f.backend,
    "POST",
    {
      applicationId: f.id,
      userId: "new-user",
      userName: "New",
      displayName: "New",
    },
  );
  expect(minted.status).toBe(201);
  const token: { token: string } = overlapCast(await minted.json());
  const registration = await request(
    f.plane,
    `/v1/authentication/public/applications/${f.id}/register/options`,
    { origin: ORIGIN },
    "POST",
    { applicationId: f.id, token: token.token },
  );
  expect(registration.status).toBe(200);
  const options: { challenge: string } = overlapCast(await registration.json());
  await error(
    await verify(f, f.signer.assertion(options.challenge)),
    400,
    "invalid_response",
  );
  expect(
    await f.plane.ctx.authenticationStores.users.get(f.id, "new-user"),
  ).toBeUndefined();
  expect(
    await f.plane.ctx.authenticationStores.credentials.get(
      f.id,
      f.signer.credentialId,
    ),
  ).toMatchObject({ counter: 0 });
  const fresh = await optionsFor(f);
  expect((await verify(f, f.signer.assertion(fresh.challenge))).status).toBe(
    200,
  );
});

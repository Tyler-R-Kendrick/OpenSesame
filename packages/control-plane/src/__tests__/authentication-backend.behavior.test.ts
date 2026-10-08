import { overlapCast } from "@opensesame/os-domain";
import { expect, it } from "vitest";
import {
  ORIGIN,
  error,
  fixture,
  request,
  seedUser,
} from "./authentication-http-fixture.js";

type Token = { token: string; expiresAt: string };

it("requires the manual feature and an existing user, then enforces purpose, expiry and one-time exchange", async () => {
  let now = Date.parse("2026-10-07T12:00:00Z");
  const f = await fixture(() => new Date(now));
  const generation = "/v1/authentication/backend/signin/generate-token";
  const verification = "/v1/authentication/backend/signin/verify-token";
  const generate = (purpose = "sign-in", ttl?: number) =>
    request(f.plane, generation, f.backend, "POST", {
      applicationId: f.id,
      userId: "fixture-user",
      purpose,
      ...(ttl ? { timeToLiveSeconds: ttl } : {}),
    });
  await error(await generate(), 403, "feature_disabled");
  expect(
    (
      await request(f.plane, f.root, f.owner, "PATCH", {
        manualTokensEnabled: true,
      })
    ).status,
  ).toBe(200);
  await error(await generate(), 404, "unknown_credential");
  await seedUser(f.plane, f.id);
  await error(await generate("missing"), 404, "configuration_not_found");
  const issued = await generate("sign-in", 2);
  expect(issued.status).toBe(201);
  const token: Token = overlapCast(await issued.json());
  expect(token.token).toMatch(/^ost_/);
  expect(Date.parse(token.expiresAt)).toBe(now + 2_000);
  const exchange = (value: string) =>
    request(f.plane, verification, f.backend, "POST", {
      applicationId: f.id,
      token: value,
    });
  const first = await exchange(token.token);
  expect(first.status).toBe(200);
  expect(await first.json()).toEqual({
    success: true,
    userId: "fixture-user",
    purpose: "sign-in",
    type: "manual",
    aliases: [],
  });
  await error(await exchange(token.token), 403, "invalid_token");
  const later: Token = overlapCast(await (await generate("step-up", 2)).json());
  now += 2_001;
  await error(await exchange(later.token), 403, "invalid_token");
  const fresh = await generate();
  expect(fresh.status).toBe(201);
  const renewed: Token = overlapCast(await fresh.json());
  expect((await exchange(renewed.token)).status).toBe(200);
});

it("normalizes duplicate visible and hashed aliases without disclosing hashes in exchanged tokens", async () => {
  const f = await fixture();
  await seedUser(f.plane, f.id);
  expect(
    (
      await request(f.plane, f.root, f.owner, "PATCH", {
        manualTokensEnabled: true,
      })
    ).status,
  ).toBe(200);
  const aliases = "/v1/authentication/backend/aliases";
  const users = `${f.root}/users`;
  const update = (hashing: boolean) =>
    request(f.plane, aliases, f.backend, "POST", {
      applicationId: f.id,
      userId: "fixture-user",
      aliases: ["Visible@Example.Test", "visible@example.test"],
      hashing,
    });
  expect((await update(false)).status).toBe(204);
  const visible = await request(f.plane, users, f.owner, "GET");
  expect(visible.status).toBe(200);
  expect(await visible.json()).toMatchObject({
    users: [{ userId: "fixture-user", aliases: ["visible@example.test"] }],
  });
  expect((await update(true)).status).toBe(204);
  const hidden = await request(f.plane, users, f.owner, "GET");
  expect(await hidden.json()).toMatchObject({ users: [{ aliases: [] }] });
  const created = await request(
    f.plane,
    "/v1/authentication/backend/signin/generate-token",
    f.backend,
    "POST",
    {
      applicationId: f.id,
      userId: "fixture-user",
    },
  );
  const token: Token = overlapCast(await created.json());
  const exchanged = await request(
    f.plane,
    "/v1/authentication/backend/signin/verify-token",
    f.backend,
    "POST",
    {
      applicationId: f.id,
      token: token.token,
    },
  );
  expect(exchanged.status).toBe(200);
  expect(await exchanged.json()).toMatchObject({ aliases: [] });
  await error(
    await request(f.plane, aliases, f.backend, "POST", {
      applicationId: f.id,
      userId: "unknown-user",
      aliases: ["alias@example.test"],
    }),
    404,
    "unknown_credential",
  );
});

it("enables magic links only for allowed callback origins and spends the delivered token once", async () => {
  const f = await fixture();
  await seedUser(f.plane, f.id);
  const send = (template = `${ORIGIN}/callback?token=$TOKEN`) =>
    request(
      f.plane,
      "/v1/authentication/backend/magic-links/send",
      f.backend,
      "POST",
      {
        applicationId: f.id,
        userId: "fixture-user",
        emailAddress: "fixture@example.test",
        urlTemplate: template,
      },
    );
  await error(await send(), 403, "feature_disabled");
  expect(f.plane.ctx.mailer.outbox).toHaveLength(0);
  expect(
    (
      await request(f.plane, f.root, f.owner, "PATCH", {
        magicLinksEnabled: true,
      })
    ).status,
  ).toBe(200);
  await error(
    await send("https://foreign.example/callback?token=$TOKEN"),
    403,
    "origin_not_allowed",
  );
  expect(f.plane.ctx.mailer.outbox).toHaveLength(0);
  expect((await send()).status).toBe(204);
  expect(f.plane.ctx.mailer.outbox).toHaveLength(1);
  const body = f.plane.ctx.mailer.outbox[0]?.body ?? "";
  const match = body.match(
    /http:\/\/localhost:5180\/callback\?token=(ost_[A-Za-z0-9_-]+)/,
  );
  const delivered = match?.[1];
  if (!delivered) throw new Error("Missing generated fixture callback token");
  const exchange = () =>
    request(
      f.plane,
      "/v1/authentication/backend/signin/verify-token",
      f.backend,
      "POST",
      {
        applicationId: f.id,
        token: delivered,
      },
    );
  const first = await exchange();
  expect(first.status).toBe(200);
  expect(await first.json()).toMatchObject({
    success: true,
    userId: "fixture-user",
    type: "magic_link",
  });
  await error(await exchange(), 403, "invalid_token");
});

import { overlapCast } from "@opensesame/os-domain";
import { expect, it } from "vitest";
import {
  ORIGIN,
  error,
  fixture,
  request,
} from "./authentication-http-fixture.js";

it("applies configured user verification and hints to actual public WebAuthn options", async () => {
  const f = await fixture();
  const config = {
    applicationId: f.id,
    purpose: "recover",
    timeToLiveSeconds: 45,
    userVerification: "required",
    hints: ["security-key"],
  };
  const route = "/v1/authentication/backend/auth-configurations";
  const created = await request(f.plane, route, f.backend, "POST", config);
  expect(created.status).toBe(201);
  await error(
    await request(f.plane, route, f.backend, "POST", config),
    409,
    "configuration_exists",
  );
  const options = () =>
    request(
      f.plane,
      `${f.root.replace("/applications/", "/public/applications/")}/signin/options`,
      { origin: ORIGIN },
      "POST",
      { applicationId: f.id, mode: "discoverable", purpose: "recover" },
    );
  const first = await options();
  expect(first.status).toBe(200);
  expect(await first.json()).toMatchObject({
    rpId: "localhost",
    userVerification: "required",
    hints: ["security-key"],
  });
  const patched = await request(
    f.plane,
    `${route}/recover`,
    f.backend,
    "PATCH",
    {
      ...config,
      userVerification: "discouraged",
      hints: ["hybrid"],
      timeToLiveSeconds: 60,
    },
  );
  expect(patched.status).toBe(204);
  const second = await options();
  expect(second.status).toBe(200);
  expect(await second.json()).toMatchObject({
    userVerification: "discouraged",
    hints: ["hybrid"],
  });
  const filtered = await request(
    f.plane,
    `${route}?applicationId=${f.id}&purpose=recover`,
    f.backend,
    "GET",
  );
  expect(filtered.status).toBe(200);
  expect(await filtered.json()).toMatchObject({
    configurations: [{ purpose: "recover", timeToLiveSeconds: 60 }],
  });
  const all = await request(
    f.plane,
    `${route}?applicationId=${f.id}`,
    f.backend,
    "GET",
  );
  const listing: { configurations: { purpose: string }[] } = overlapCast(
    await all.json(),
  );
  expect(listing.configurations.map((c) => c.purpose)).toEqual(
    expect.arrayContaining(["sign-in", "step-up", "recover"]),
  );
  for (const purpose of ["sign-in", "step-up"]) {
    await error(
      await request(f.plane, `${route}/${purpose}`, f.backend, "DELETE", {
        applicationId: f.id,
      }),
      409,
      "built_in_configuration",
    );
  }
  expect(
    (
      await request(f.plane, `${route}/recover`, f.backend, "DELETE", {
        applicationId: f.id,
      })
    ).status,
  ).toBe(204);
  await error(await options(), 404, "configuration_not_found");
  await error(
    await request(f.plane, `${route}/recover`, f.backend, "DELETE", {
      applicationId: f.id,
    }),
    404,
    "not_found",
  );
  await error(
    await request(f.plane, `${route}/missing`, f.backend, "PATCH", config),
    404,
    "not_found",
  );
});

it("requires origin and refuses invalid tokens without burning a valid registration token", async () => {
  const f = await fixture();
  const minted = await request(
    f.plane,
    "/v1/authentication/backend/registration-tokens",
    f.backend,
    "POST",
    {
      applicationId: f.id,
      userId: "registration-user",
      userName: "Fixture",
      displayName: "Fixture User",
      userVerification: "required",
      authenticatorAttachment: "cross-platform",
    },
  );
  expect(minted.status).toBe(201);
  const issued: { token: string } = overlapCast(await minted.json());
  const path = `/v1/authentication/public/applications/${f.id}/register/options`;
  const body = { applicationId: f.id, token: issued.token };
  await error(await request(f.plane, path, {}, "POST", body), 404, "not_found");
  await error(
    await request(
      f.plane,
      path,
      { origin: "https://foreign.example" },
      "POST",
      body,
    ),
    404,
    "not_found",
  );
  await error(
    await request(f.plane, path, { origin: ORIGIN }, "POST", {
      ...body,
      token: "ort_unknown",
    }),
    403,
    "invalid_token",
  );
  const admitted = await request(
    f.plane,
    path,
    { origin: ORIGIN },
    "POST",
    body,
  );
  expect(admitted.status).toBe(200);
  expect(await admitted.json()).toMatchObject({
    authenticatorSelection: {
      userVerification: "required",
      authenticatorAttachment: "cross-platform",
    },
  });
});

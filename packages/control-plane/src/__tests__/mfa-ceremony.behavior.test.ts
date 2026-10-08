import { randomBytes } from "node:crypto";
import { type JsonObject, overlapCast } from "@opensesame/os-domain";
import { expect, it } from "vitest";
import { createControlPlane } from "../create-app.js";
import { error, request } from "./authentication-http-fixture.js";
import { assertionFor, enrolPasskey } from "./interaction-webauthn-fixture.js";
import { signedIn } from "./mfa-step-up-fixture.js";

function strictPlane(clock?: () => Date) {
  return createControlPlane({
    processEnv: { NODE_ENV: "test", OPENSESAME_ALLOW_DEV_DEFAULTS: "1" },
    ...(clock ? { clock } : {}),
    config: {
      port: 0,
      publicUrl: "http://127.0.0.1:8788",
      issuer: "http://127.0.0.1:8788",
      allowDevDefaults: false,
      claimPepper: randomBytes(32).toString("hex"),
    },
  });
}
async function challenge(
  plane: ReturnType<typeof createControlPlane>,
  accessToken: string,
) {
  const result = await request(
    plane,
    "/v1/mfa/passkey/authentication-options",
    { authorization: `Bearer ${accessToken}` },
  );
  expect(result.status).toBe(200);
  const body: { challenge: string } = overlapCast(await result.json());
  return body.challenge;
}
function damaged(assertion: JsonObject): JsonObject {
  const signature = Buffer.from(String(assertion.signature), "base64url");
  signature[0] = (signature[0] ?? 0) ^ 1;
  return { ...assertion, signature: signature.toString("base64url") };
}

it("strict ceremony configuration refuses development stubs while minting real passkey options", async () => {
  const plane = strictPlane();
  const human = await signedIn(plane);
  const headers = { authorization: `Bearer ${human.accessToken}` };
  await error(
    await request(plane, "/v1/mfa/passkey/register", headers, "POST", {
      credentialId: "fixture-stub",
      publicKey: Buffer.from("stub").toString("base64"),
    }),
    400,
    "registration_attestation_required",
  );
  await error(
    await request(plane, "/v1/mfa/totp/enroll", headers),
    403,
    "totp_dev_only",
  );
  await error(
    await request(plane, "/v1/mfa/totp/verify", headers, "POST", {
      code: "000000",
    }),
    403,
    "totp_dev_only",
  );
  const real = await request(
    plane,
    "/v1/mfa/passkey/registration-options",
    headers,
  );
  expect(real.status).toBe(200);
  const options: { challenge: string; options: { rp: { id: string } } } =
    overlapCast(await real.json());
  expect(options.challenge.length).toBeGreaterThan(8);
  expect(options.options.rp.id).toBe("127.0.0.1");
  expect(await plane.ctx.stores.totpSecrets.has(human.principalId)).toBe(false);
});

it("verifies genuine signed assertions, refuses a modified signature and never accepts replay", async () => {
  const plane = strictPlane();
  const human = await signedIn(plane);
  // Existing fixture stores an actual generated EC public key; production
  // SimpleWebAuthn signature verification is never replaced with a boolean verdict.
  const key = await enrolPasskey(plane, human.principalId);
  const first = assertionFor(await challenge(plane, human.accessToken), key);
  expect(
    (await request(plane, "/v1/mfa/passkey/assert", {}, "POST", damaged(first)))
      .status,
  ).toBe(401);
  const fresh = assertionFor(await challenge(plane, human.accessToken), key);
  const accepted = await request(
    plane,
    "/v1/mfa/passkey/assert",
    {},
    "POST",
    fresh,
  );
  expect(accepted.status).toBe(200);
  expect(await accepted.json()).toEqual({
    ok: true,
    principalId: human.principalId,
  });
  const replay = await request(
    plane,
    "/v1/mfa/passkey/assert",
    {},
    "POST",
    fresh,
  );
  expect(replay.status).toBe(401);
});

it("audits a real credential failure fence without exposing the credential and keeps another credential usable", async () => {
  let at = Date.now();
  const plane = strictPlane(() => new Date(at));
  const human = await signedIn(plane);
  const key = await enrolPasskey(plane, human.principalId);
  const invalid = damaged(
    assertionFor(await challenge(plane, human.accessToken), key),
  );
  for (let attempt = 0; attempt < 5; attempt++) {
    expect(
      (await request(plane, "/v1/mfa/passkey/assert", {}, "POST", invalid))
        .status,
    ).toBe(401);
  }
  // Advance the injected service clock past the audit throttle and anonymous
  // window. The credential failure fence remains spent; no ledger is edited.
  at += 61_000;
  const fenced = await request(
    plane,
    "/v1/mfa/passkey/assert",
    {},
    "POST",
    assertionFor(await challenge(plane, human.accessToken), key),
  );
  expect(fenced.status).toBe(429);
  expect(await fenced.json()).toEqual({
    ok: false,
    error: "too_many_attempts",
  });
  const audits = await plane.ctx.repos.auditEvents.list({ limit: 200 });
  expect(
    audits.some(
      (event) =>
        event.eventType === "mfa.passkey.assert" &&
        event.metadata.reason === "too_many_attempts",
    ),
  ).toBe(true);
  expect(JSON.stringify(audits)).not.toContain(key);
  expect(JSON.stringify(audits)).not.toContain(String(invalid.signature));
  const independent = await enrolPasskey(plane, human.principalId);
  const permitted = await request(
    plane,
    "/v1/mfa/passkey/assert",
    {},
    "POST",
    assertionFor(await challenge(plane, human.accessToken), independent),
  );
  expect(permitted.status).toBe(200);
});

it("requires a configured mail provider and creates no challenge after delivery refusal", async () => {
  // An explicit provider-free environment uses the actual unconfigured mailer.
  const plane = strictPlane();
  const human = await signedIn(plane);
  const refused = await request(
    plane,
    "/v1/mfa/code/send",
    { authorization: `Bearer ${human.accessToken}` },
    "POST",
    {
      channel: "email",
      to: "fixture@example.test",
    },
  );
  expect(refused.status).toBe(503);
  expect(await refused.json()).toMatchObject({ error: "mail_not_configured" });
  expect(plane.ctx.mailer.outbox).toHaveLength(0);
  expect(await plane.ctx.stores.mfaCodes.size).toBe(0);
});

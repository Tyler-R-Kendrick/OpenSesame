import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
} from "node:crypto";
import { type JsonObject, overlapCast } from "@opensesame/os-domain";
import { expect } from "vitest";
import {
  ORIGIN,
  fixture,
  request,
  seedUser,
} from "./authentication-http-fixture.js";

export type AuthenticationFixture = Awaited<ReturnType<typeof fixture>>;

// The integrating backend's enrolled public key is seeded into the real
// repository. Signing and SimpleWebAuthn verification remain real; this does
// not exercise registration attestation or a hardware authenticator.
export async function enrolledCredential(
  f: AuthenticationFixture,
  userId = "fixture-user",
  applicationId = f.id,
) {
  const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = keys.publicKey.export({ format: "jwk" });
  if (!jwk.x || !jwk.y) throw new Error("public key coordinates missing");
  const publicKey = Buffer.concat([
    Buffer.from("a5010203262001215820", "hex"),
    Buffer.from(jwk.x, "base64url"),
    Buffer.from("225820", "hex"),
    Buffer.from(jwk.y, "base64url"),
  ]);
  const credentialId = randomBytes(16).toString("base64url");
  const now = f.plane.ctx.clock();
  await f.plane.ctx.authenticationStores.credentials.create({
    applicationId,
    userId,
    credentialId,
    publicKey,
    counter: 0,
    transports: ["internal"],
    createdAt: now,
    updatedAt: now,
  });
  function assertion(
    challenge: string,
    options: { counter?: number; origin?: string; flags?: number } = {},
  ): JsonObject {
    const clientData = Buffer.from(
      JSON.stringify({
        type: "webauthn.get",
        challenge,
        origin: options.origin ?? ORIGIN,
      }),
    );
    const count = Buffer.alloc(4);
    count.writeUInt32BE(options.counter ?? 1);
    const authenticatorData = Buffer.concat([
      createHash("sha256").update("localhost").digest(),
      Buffer.from([options.flags ?? 0x05]),
      count,
    ]);
    const signature = sign(
      "sha256",
      Buffer.concat([
        authenticatorData,
        createHash("sha256").update(clientData).digest(),
      ]),
      keys.privateKey,
    );
    return {
      id: credentialId,
      rawId: credentialId,
      type: "public-key",
      clientExtensionResults: {},
      response: {
        clientDataJSON: clientData.toString("base64url"),
        authenticatorData: authenticatorData.toString("base64url"),
        signature: signature.toString("base64url"),
      },
    };
  }
  return { credentialId, assertion };
}

export async function signedFixture(clock?: () => Date) {
  const f = await fixture(clock);
  await seedUser(f.plane, f.id);
  return { ...f, signer: await enrolledCredential(f) };
}

export async function optionsFor(
  f: AuthenticationFixture,
  input: JsonObject = { mode: "user_id", userId: "fixture-user" },
) {
  const result = await request(
    f.plane,
    `/v1/authentication/public/applications/${f.id}/signin/options`,
    { origin: ORIGIN },
    "POST",
    {
      applicationId: f.id,
      purpose: "step-up",
      ...input,
    },
  );
  expect(result.status).toBe(200);
  const body: { challenge: string; allowCredentials?: { id: string }[] } =
    overlapCast(await result.json());
  expect(body.challenge.length).toBeGreaterThan(0);
  return body;
}

export function verify(f: AuthenticationFixture, response: JsonObject) {
  return request(
    f.plane,
    `/v1/authentication/public/applications/${f.id}/signin/verify`,
    { origin: ORIGIN },
    "POST",
    { applicationId: f.id, response },
  );
}

export function exchange(f: AuthenticationFixture, token: string) {
  return request(
    f.plane,
    "/v1/authentication/backend/signin/verify-token",
    f.backend,
    "POST",
    { applicationId: f.id, token },
  );
}

/**
 * Virtual WebAuthn for interaction activation tests. Assertions reach the
 * real SimpleWebAuthn verifier on createControlPlane.
 */

import {
  type KeyObject,
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
} from "node:crypto";
import { type JsonObject, overlapCast } from "@opensesame/os-domain";
import type { createControlPlane } from "../create-app.js";

type Plane = ReturnType<typeof createControlPlane>;

const credentialKeys = new Map<string, KeyObject>();

export async function enrolPasskey(
  cp: Plane,
  principalId: string,
): Promise<string> {
  const key = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = key.publicKey.export({ format: "jwk" });
  if (!jwk.x || !jwk.y) throw new Error("public coordinates missing");
  const publicKey = Buffer.concat([
    Buffer.from("a5010203262001215820", "hex"),
    Buffer.from(jwk.x, "base64url"),
    Buffer.from("225820", "hex"),
    Buffer.from(jwk.y, "base64url"),
  ]);
  const credentialId = randomBytes(16).toString("base64url");
  await cp.ctx.passkeys.register(principalId, {
    credentialId,
    publicKey,
    counter: 0,
  });
  credentialKeys.set(credentialId, key.privateKey);
  return credentialId;
}

export function assertionFor(
  challenge: string,
  credentialId: string,
): JsonObject {
  const privateKey = credentialKeys.get(credentialId);
  if (!privateKey) throw new Error(`no signing key for ${credentialId}`);
  const clientData = Buffer.from(
    JSON.stringify({
      type: "webauthn.get",
      challenge,
      origin: "http://127.0.0.1:8788",
    }),
  );
  const authData = Buffer.concat([
    createHash("sha256").update("127.0.0.1").digest(),
    Buffer.from([0x05]),
    Buffer.from([0, 0, 0, 1]),
  ]);
  const signature = sign(
    "sha256",
    Buffer.concat([authData, createHash("sha256").update(clientData).digest()]),
    privateKey,
  );
  return {
    credentialId,
    clientDataJSON: clientData.toString("base64url"),
    authenticatorData: authData.toString("base64url"),
    signature: signature.toString("base64url"),
  };
}

export async function beginInteractionActivation(
  cp: Plane,
  token: string,
  ref: string,
  requestDigest: string,
): Promise<{ activationId: string; challenge: string; status: number }> {
  const begun = await cp.app.request(`/v1/interactions/${ref}/activation`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ decision: "approved", requestDigest }),
  });
  const body = overlapCast(await begun.json());
  const options = overlapCast(body.options ?? {});
  const challenge = options.challenge;
  return {
    status: begun.status,
    activationId: String(body.activationId ?? ""),
    challenge: typeof challenge === "string" ? challenge : "",
  };
}

export function completeInteractionActivation(
  cp: Plane,
  token: string,
  ref: string,
  activationId: string,
  assertion: JsonObject,
) {
  return cp.app.request(`/v1/interactions/${ref}/activation/complete`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ activationId, ...assertion }),
  });
}

export async function activateInteraction(
  cp: Plane,
  token: string,
  ref: string,
  requestDigest: string,
  credentialId: string,
): Promise<string> {
  const begun = await beginInteractionActivation(cp, token, ref, requestDigest);
  if (typeof begun.challenge !== "string" || begun.challenge.length === 0) {
    throw new Error("activation options missing challenge");
  }
  await completeInteractionActivation(
    cp,
    token,
    ref,
    begun.activationId,
    assertionFor(begun.challenge, credentialId),
  );
  return begun.activationId;
}

import {
  type BoundaryValue,
  isBoolean,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import {
  CompactSign,
  calculateJwkThumbprint,
  compactVerify,
  exportJWK,
  generateKeyPair,
  importJWK,
} from "jose";
import { exactOrigin } from "./transport.js";

export type LocalAgentPublicKey = {
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
};
export type LocalAgentChallenge = Readonly<{
  nonce: string;
  principalId: string;
  keyId: string;
  origin: string;
  expiresAt: number;
}>;
const TYP = "opensesame-local-agent+jws";
const PUBLIC_FIELDS = new Set([
  "kty",
  "crv",
  "x",
  "y",
  "alg",
  "use",
  "ext",
  "key_ops",
]);

function metadata(value: Record<string, BoundaryValue>): boolean {
  return (
    (value.alg === undefined || value.alg === "ES256") &&
    (value.use === undefined || value.use === "sig") &&
    (value.ext === undefined || isBoolean(value.ext)) &&
    (value.key_ops === undefined ||
      (Array.isArray(value.key_ops) &&
        value.key_ops.length === 1 &&
        value.key_ops[0] === "verify"))
  );
}

/** Accept only public ES256 keys; never silently discard private key material. */
export async function localAgentPublicKey(value: BoundaryValue) {
  if (
    !isJsonObject(value) ||
    !Object.keys(value).every((field) => PUBLIC_FIELDS.has(field)) ||
    value.kty !== "EC" ||
    value.crv !== "P-256" ||
    !isString(value.x) ||
    !/^[A-Za-z0-9_-]{43}$/.test(value.x) ||
    !isString(value.y) ||
    !/^[A-Za-z0-9_-]{43}$/.test(value.y) ||
    !metadata(value)
  )
    throw new Error("invalid_agent_public_key");
  const publicKey: LocalAgentPublicKey = {
    kty: "EC",
    crv: "P-256",
    x: value.x,
    y: value.y,
  };
  await importJWK(publicKey, "ES256");
  return {
    publicKey,
    keyId: await calculateJwkThumbprint(publicKey, "sha256"),
  };
}

function challengePayload(challenge: LocalAgentChallenge): string {
  if (
    !/^[A-Za-z0-9_-]{43}$/.test(challenge.nonce) ||
    !/^local_[0-9a-f-]{36}$/.test(challenge.principalId) ||
    !/^[A-Za-z0-9_-]{43}$/.test(challenge.keyId) ||
    challenge.origin !== exactOrigin(challenge.origin) ||
    !Number.isSafeInteger(challenge.expiresAt) ||
    challenge.expiresAt <= 0
  )
    throw new Error("invalid_agent_challenge");
  return JSON.stringify({
    nonce: challenge.nonce,
    principalId: challenge.principalId,
    keyId: challenge.keyId,
    origin: challenge.origin,
    expiresAt: challenge.expiresAt,
  });
}

/** Client-side key custody: only the public key and a signing operation escape. */
export async function createLocalAgentKey() {
  const pair = await generateKeyPair("ES256", { extractable: false });
  const key = await localAgentPublicKey(await exportJWK(pair.publicKey));
  return {
    ...key,
    async signChallenge(
      challenge: LocalAgentChallenge,
      expectedOrigin: string,
      principalId: string,
    ) {
      if (
        challenge.origin !== exactOrigin(expectedOrigin) ||
        challenge.principalId !== principalId ||
        challenge.keyId !== key.keyId
      )
        throw new Error("agent_challenge_binding_mismatch");
      return new CompactSign(
        new TextEncoder().encode(challengePayload(challenge)),
      )
        .setProtectedHeader({ alg: "ES256", typ: TYP, kid: key.keyId })
        .sign(pair.privateKey);
    },
  };
}

/** The issuer supplies its saved challenge/key, never metadata from the proof. */
export async function verifyLocalAgentChallenge(
  proof: string,
  challenge: LocalAgentChallenge,
  publicKey: LocalAgentPublicKey,
): Promise<void> {
  if (!isString(proof) || proof.length > 8192)
    throw new Error("invalid_agent_proof");
  const key = await localAgentPublicKey(publicKey);
  if (key.keyId !== challenge.keyId) throw new Error("invalid_agent_proof");
  const verified = await compactVerify(
    proof,
    await importJWK(key.publicKey, "ES256"),
    { algorithms: ["ES256"] },
  );
  if (
    verified.protectedHeader.typ !== TYP ||
    verified.protectedHeader.kid !== key.keyId ||
    !Object.keys(verified.protectedHeader).every((field) =>
      ["alg", "typ", "kid"].includes(field),
    ) ||
    new TextDecoder("utf-8", { fatal: true }).decode(verified.payload) !==
      challengePayload(challenge)
  )
    throw new Error("invalid_agent_proof");
}

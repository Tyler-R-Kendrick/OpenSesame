/** An adversarial link holder can authenticate outer envelopes; the code must still protect payloads. */
import { type JsonObject, overlapCast } from "@opensesame/os-domain";
import { b64urlToBytes, bytesToB64url } from "@opensesame/vault-core";

const encoder = new TextEncoder();

export async function rewritePortableEnvelope(
  packet: string,
  bearerToken: string,
  change: (root: JsonObject) => void,
): Promise<string> {
  const [prefix, claimId, digest, nonce, ciphertext] = packet.split(".");
  const secret = bearerToken.split(".")[1];
  if (!prefix || !claimId || !digest || !nonce || !ciphertext || !secret)
    throw new Error("fixture packet is incomplete");
  const material = await crypto.subtle.importKey(
    "raw",
    b64urlToBytes(secret),
    "HKDF",
    false,
    ["deriveKey"],
  );
  const key = await crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: encoder.encode(claimId),
      info: encoder.encode("opensesame.portable-drop.transport.v2"),
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  const aad = (iv: string) =>
    encoder.encode(JSON.stringify([prefix, claimId, digest, iv]));
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: b64urlToBytes(nonce), additionalData: aad(nonce) },
    key,
    b64urlToBytes(ciphertext),
  );
  const root: JsonObject = overlapCast(
    JSON.parse(new TextDecoder().decode(plaintext)),
  );
  change(root);
  const nextNonce = crypto.getRandomValues(new Uint8Array(12));
  const nextText = bytesToB64url(nextNonce);
  const nextCiphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nextNonce, additionalData: aad(nextText) },
    key,
    encoder.encode(JSON.stringify(root)),
  );
  return [
    prefix,
    claimId,
    digest,
    nextText,
    bytesToB64url(new Uint8Array(nextCiphertext)),
  ].join(".");
}

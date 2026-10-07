/** Public numeric key bytes and independent wire construction, not production sealing helpers. */
import type {
  ObservationAcknowledgement,
  ObservationMetadata,
  ObservationReceiverProvision,
  SealedObservationPackage,
} from "@opensesame/app-core/lib/credential-observation/protocol.js";
type UnsignedWireBody =
  | Omit<SealedObservationPackage, "macB64">
  | Omit<ObservationAcknowledgement, "macB64">;
const PURPOSE = "opensesame/credential-observation/v1";
const ACK_PURPOSE = "opensesame/credential-observation/ack/v1";
const utf8 = (value: string) => new TextEncoder().encode(value);
export function provision(now = Date.now()): ObservationReceiverProvision {
  return {
    v: 1,
    receiverId: "public-fuzz-receiver",
    bindingId: "public-fuzz-binding",
    origin: "https://controlled.example",
    allowLoopback: false,
    keyEpoch: 7,
    expiresAt: new Date(now + 86400000).toISOString(),
    independentKeyMaterialB64: Buffer.from(
      Array.from({ length: 64 }, (_, i) => i),
    ).toString("base64"),
  };
}
export function metadata(now = Date.now()): ObservationMetadata {
  return {
    v: 1,
    eventId: "08d6b122-3d27-4b93-b823-f51097a41723",
    vaultIdentity: "public-fuzz-vault",
    event: { type: "receiver_test" },
    at: new Date(now).toISOString(),
  };
}
async function key(algorithm: "AES-GCM" | "HMAC"): Promise<CryptoKey> {
  const bytes = Uint8Array.from(
    { length: 32 },
    (_, i) => i + (algorithm === "HMAC" ? 32 : 0),
  );
  try {
    return await crypto.subtle.importKey(
      "raw",
      bytes,
      algorithm === "HMAC" ? { name: "HMAC", hash: "SHA-256" } : "AES-GCM",
      false,
      algorithm === "HMAC" ? ["sign"] : ["encrypt"],
    );
  } finally {
    bytes.fill(0);
  }
}
async function mac(purpose: string, body: UnsignedWireBody): Promise<string> {
  const signature = await crypto.subtle.sign(
    "HMAC",
    await key("HMAC"),
    utf8(`${purpose}\n${JSON.stringify(body)}`),
  );
  return Buffer.from(signature).toString("base64");
}
export async function signedPackage(
  p: SealedObservationPackage,
): Promise<SealedObservationPackage> {
  const body = {
    v: p.v,
    packageId: p.packageId,
    receiverId: p.receiverId,
    bindingId: p.bindingId,
    keyEpoch: p.keyEpoch,
    issuedAt: p.issuedAt,
    expiresAt: p.expiresAt,
    nonceB64: p.nonceB64,
    ciphertextB64: p.ciphertextB64,
  };
  return { ...body, macB64: await mac(PURPOSE, body) };
}
export async function packet(
  plaintext: Uint8Array<ArrayBuffer>,
  now = Date.now(),
  aad = PURPOSE,
): Promise<SealedObservationPackage> {
  const iv = Uint8Array.from({ length: 12 }, (_, i) => i + 1);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: utf8(aad), tagLength: 128 },
      await key("AES-GCM"),
      plaintext,
    ),
  );
  const packed = new Uint8Array(12 + ciphertext.length);
  packed.set(iv);
  packed.set(ciphertext, 12);
  return signedPackage({
    v: 1,
    packageId: "5188635b-22f7-4335-8266-9e3f75b1d5d2",
    receiverId: "public-fuzz-receiver",
    bindingId: "public-fuzz-binding",
    keyEpoch: 7,
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 3600000).toISOString(),
    nonceB64: Buffer.from(Array.from({ length: 16 }, (_, i) => i + 2)).toString(
      "base64",
    ),
    ciphertextB64: Buffer.from(packed).toString("base64"),
    macB64: "",
  });
}
export async function signedAck(
  p: SealedObservationPackage,
  now = Date.now(),
  purpose = ACK_PURPOSE,
): Promise<ObservationAcknowledgement> {
  const body = {
    v: 1 as const,
    packageId: p.packageId,
    bindingId: p.bindingId,
    keyEpoch: p.keyEpoch,
    acceptedAt: new Date(now).toISOString(),
  };
  return { ...body, macB64: await mac(purpose, body) };
}
export async function signedAckBody(
  a: ObservationAcknowledgement,
): Promise<ObservationAcknowledgement> {
  const body = {
    v: a.v,
    packageId: a.packageId,
    bindingId: a.bindingId,
    keyEpoch: a.keyEpoch,
    acceptedAt: a.acceptedAt,
  };
  return { ...body, macB64: await mac(ACK_PURPOSE, body) };
}

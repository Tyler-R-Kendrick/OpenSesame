/** Exact independent AES-256-GCM/HMAC-SHA256 key split; never a vault-root key. */
import { b64ToBytes, bytesToB64 } from "@opensesame/vault-core/bytes.js";
import {
  ACK_PURPOSE,
  CLOCK_SKEW_MS,
  MAX_PACKAGE_BYTES,
  OBSERVATION_PURPOSE,
  type ObservationAcknowledgement,
  type ObservationMetadata,
  type ObservationReceiverProvision,
  PACKAGE_TTL_MS,
  type SealedObservationPackage,
  ackBody,
  ackSchema,
  canonicalBase64,
  metadataSchema,
  packageBody,
  packageSchema,
} from "./protocol.js";
const utf8 = (value: string) => new TextEncoder().encode(value);
export type ObservationKeys = { encrypt: CryptoKey; mac: CryptoKey };
export async function importObservationKeys(
  material: string,
): Promise<ObservationKeys> {
  const raw = canonicalBase64(material, 64);
  const aes = raw.slice(0, 32);
  const mac = raw.slice(32);
  try {
    const encrypt = await crypto.subtle.importKey(
      "raw",
      aes,
      "AES-GCM",
      false,
      ["encrypt", "decrypt"],
    );
    return {
      encrypt,
      mac: await crypto.subtle.importKey(
        "raw",
        mac,
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign", "verify"],
      ),
    };
  } finally {
    raw.fill(0);
    aes.fill(0);
    mac.fill(0);
  }
}
async function sign(
  keys: ObservationKeys,
  purpose: string,
  body: string,
): Promise<string> {
  return bytesToB64(
    new Uint8Array(
      await crypto.subtle.sign("HMAC", keys.mac, utf8(`${purpose}\n${body}`)),
    ),
  );
}
async function verify(
  keys: ObservationKeys,
  purpose: string,
  body: string,
  mac: string,
): Promise<void> {
  if (
    !(await crypto.subtle.verify(
      "HMAC",
      keys.mac,
      canonicalBase64(mac, 32),
      utf8(`${purpose}\n${body}`),
    ))
  )
    throw new Error(
      "Observation acknowledgement or package authentication failed.",
    );
}
function times(
  p: SealedObservationPackage,
  provision: ObservationReceiverProvision,
  now: number,
): void {
  const issued = Date.parse(p.issuedAt);
  const expires = Date.parse(p.expiresAt);
  if (
    p.receiverId !== provision.receiverId ||
    p.bindingId !== provision.bindingId ||
    p.keyEpoch !== provision.keyEpoch ||
    issued > now + CLOCK_SKEW_MS ||
    expires <= now ||
    expires <= issued ||
    expires - issued > PACKAGE_TTL_MS ||
    expires > Date.parse(provision.expiresAt)
  )
    throw new Error("Observation binding or expiry is invalid.");
  canonicalBase64(p.nonceB64, 16);
}
export async function sealObservation(
  input: ObservationMetadata,
  provision: ObservationReceiverProvision,
  now = Date.now(),
): Promise<SealedObservationPackage> {
  const m = metadataSchema.parse(input);
  const plaintext = utf8(
    JSON.stringify({
      v: 1,
      eventId: m.eventId,
      vaultIdentity: m.vaultIdentity,
      event: m.event,
      at: m.at,
    }),
  );
  if (plaintext.length > 2048) {
    plaintext.fill(0);
    throw new Error("Observation metadata is too large.");
  }
  const expires = Math.min(
    now + PACKAGE_TTL_MS,
    Date.parse(provision.expiresAt),
  );
  if (expires <= now) throw new Error("Observation receiver binding expired.");
  try {
    const keys = await importObservationKeys(
      provision.independentKeyMaterialB64,
    );
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = new Uint8Array(
      await crypto.subtle.encrypt(
        {
          name: "AES-GCM",
          iv,
          additionalData: utf8(OBSERVATION_PURPOSE),
          tagLength: 128,
        },
        keys.encrypt,
        plaintext,
      ),
    );
    const packed = new Uint8Array(12 + ciphertext.length);
    packed.set(iv);
    packed.set(ciphertext, 12);
    const unsigned = {
      v: 1 as const,
      packageId: crypto.randomUUID(),
      receiverId: provision.receiverId,
      bindingId: provision.bindingId,
      keyEpoch: provision.keyEpoch,
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(expires).toISOString(),
      nonceB64: bytesToB64(crypto.getRandomValues(new Uint8Array(16))),
      ciphertextB64: bytesToB64(packed),
    };
    const result = {
      ...unsigned,
      macB64: await sign(keys, OBSERVATION_PURPOSE, packageBody(unsigned)),
    };
    if (utf8(JSON.stringify(result)).length > MAX_PACKAGE_BYTES)
      throw new Error("Sealed observation is too large.");
    return result;
  } finally {
    plaintext.fill(0);
  }
}
export async function openObservation(
  raw: string,
  provision: ObservationReceiverProvision,
  now = Date.now(),
): Promise<ObservationMetadata> {
  if (utf8(raw).length > MAX_PACKAGE_BYTES)
    throw new Error("Sealed observation is too large.");
  const p = packageSchema.parse(JSON.parse(raw));
  times(p, provision, now);
  const keys = await importObservationKeys(provision.independentKeyMaterialB64);
  await verify(keys, OBSERVATION_PURPOSE, packageBody(p), p.macB64);
  const packed = b64ToBytes(p.ciphertextB64);
  if (packed.length < 28 || bytesToB64(packed) !== p.ciphertextB64)
    throw new Error("Invalid sealed observation.");
  const plaintext = new Uint8Array(
    await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: packed.slice(0, 12),
        additionalData: utf8(OBSERVATION_PURPOSE),
        tagLength: 128,
      },
      keys.encrypt,
      packed.slice(12),
    ),
  );
  try {
    const metadata = metadataSchema.parse(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext)),
    );
    if (
      Date.parse(metadata.at) > now + CLOCK_SKEW_MS ||
      Date.parse(metadata.at) < Date.parse(p.issuedAt) - PACKAGE_TTL_MS
    )
      throw new Error("Observation timestamp is invalid.");
    return metadata;
  } finally {
    plaintext.fill(0);
  }
}
/** Sender validates only the sealed envelope, never opens its metadata. */
export async function authenticateSealedObservation(
  p: SealedObservationPackage,
  provision: ObservationReceiverProvision,
): Promise<void> {
  packageSchema.parse(p);
  times(p, provision, Date.now());
  await verify(
    await importObservationKeys(provision.independentKeyMaterialB64),
    OBSERVATION_PURPOSE,
    packageBody(p),
    p.macB64,
  );
}
export async function acknowledgeObservation(
  p: SealedObservationPackage,
  provision: ObservationReceiverProvision,
  now = Date.now(),
): Promise<ObservationAcknowledgement> {
  times(p, provision, now);
  const unsigned = {
    v: 1 as const,
    packageId: p.packageId,
    bindingId: p.bindingId,
    keyEpoch: p.keyEpoch,
    acceptedAt: new Date(now).toISOString(),
  };
  const keys = await importObservationKeys(provision.independentKeyMaterialB64);
  return {
    ...unsigned,
    macB64: await sign(keys, ACK_PURPOSE, ackBody(unsigned)),
  };
}
export async function verifyObservationAcknowledgement(
  raw: string,
  p: SealedObservationPackage,
  provision: ObservationReceiverProvision,
): Promise<void> {
  if (utf8(raw).length > 2048)
    throw new Error("Observation acknowledgement is too large.");
  const ack = ackSchema.parse(JSON.parse(raw));
  const now = Date.now();
  times(p, provision, now);
  const accepted = Date.parse(ack.acceptedAt);
  if (
    ack.packageId !== p.packageId ||
    ack.bindingId !== p.bindingId ||
    ack.keyEpoch !== p.keyEpoch ||
    accepted < Date.parse(p.issuedAt) - CLOCK_SKEW_MS ||
    accepted > Math.min(Date.parse(p.expiresAt), now + CLOCK_SKEW_MS)
  )
    throw new Error("Observation acknowledgement binding is invalid.");
  await verify(
    await importObservationKeys(provision.independentKeyMaterialB64),
    ACK_PURPOSE,
    ackBody(ack),
    ack.macB64,
  );
}

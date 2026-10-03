/**
 * The candidate's backup, and what makes its acknowledgement true
 * (ADR 0076 §3 constraint 2).
 *
 * A candidate lost after the site accepted it is an unrecoverable lockout, so
 * the run waits to be told it is durably written before anything is typed. The
 * extension's own copy is sealed under a device key that cannot leave this
 * browser profile, so it is not a backup: lose the profile and it is gone. A
 * backup the extension can truthfully acknowledge has to be recoverable from
 * somewhere else, and that needs a key that is not on this device.
 *
 * So the backup is a hybrid envelope addressed to a **recovery recipient** the
 * person provisions (an RSA-OAEP public key whose private half they keep
 * off-device), pushed to the Host as opaque ciphertext through the sync route,
 * and acknowledged only when the Host both accepted it and returns the very
 * same ciphertext on a read-back. The Host holds ciphertext it cannot open; the
 * person holds the one key that can. With no recipient provisioned there is no
 * backup to acknowledge, and the answer is `backed_up: false`, so the executor
 * blocks before the submit.
 */
import { b64, sha256Hex } from "./bytes";

export const RECIPIENT_ALG = "RSA-OAEP-256";
/** Smaller than this is not a recovery key. */
export const MIN_MODULUS_BITS = 3072;
const ENVELOPE_VERSION = 1;
const WRAP = { name: "RSA-OAEP" } as const;

export interface RecoveryRecipient {
  /** The key's thumbprint: names the recipient without being it. */
  kid: string;
  jwk: JsonWebKey;
}

export interface RecoveryKeyPair {
  recipient: RecoveryRecipient;
  /** Shown to the person once and never stored here. */
  privateJwk: JsonWebKey;
}

/** The members of a public RSA JWK, in the order RFC 7638 hashes them. */
function thumbprintInput(jwk: JsonWebKey): string {
  return JSON.stringify({ e: jwk.e, kty: jwk.kty, n: jwk.n });
}

function modulusBits(n: string): number {
  const bytes = b64.fromUrl(n);
  const lead = bytes[0] ?? 0;
  return bytes.length * 8 - Math.clz32(lead) + 24;
}

/**
 * The recipient `jwk` names, or `null` when it is not a public RSA-OAEP key of
 * at least 3072 bits (a private key, a symmetric key and a short key all refuse:
 * the extension holds the public half only).
 */
export async function importRecipient(
  jwk: JsonWebKey,
): Promise<RecoveryRecipient | null> {
  if (jwk.kty !== "RSA" || !jwk.n || !jwk.e) return null;
  if (jwk.d || jwk.p || jwk.q || jwk.dp || jwk.dq || jwk.qi) return null;
  if (jwk.alg !== undefined && jwk.alg !== RECIPIENT_ALG) return null;
  try {
    if (modulusBits(jwk.n) < MIN_MODULUS_BITS) return null;
    const publicJwk: JsonWebKey = {
      kty: "RSA",
      n: jwk.n,
      e: jwk.e,
      alg: RECIPIENT_ALG,
      ext: true,
      key_ops: ["encrypt"],
    };
    await crypto.subtle.importKey(
      "jwk",
      publicJwk,
      { ...WRAP, hash: "SHA-256" },
      false,
      ["encrypt"],
    );
    return { kid: await sha256Hex(thumbprintInput(publicJwk)), jwk: publicJwk };
  } catch {
    return null;
  }
}

/** A fresh recovery key pair; the private half is for the person, not for us. */
export async function createRecoveryKey(): Promise<RecoveryKeyPair> {
  const pair = await crypto.subtle.generateKey(
    {
      ...WRAP,
      modulusLength: MIN_MODULUS_BITS,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["encrypt", "decrypt"],
  );
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const recipient = await importRecipient(publicJwk);
  if (!recipient) throw new Error("recovery_key_unusable");
  return { recipient, privateJwk: { ...privateJwk, alg: RECIPIENT_ALG } };
}

/** What an envelope is bound to, so one candidate's backup opens as no other. */
export interface BackupBinding {
  handle: string;
  origin: string;
}

function aad(binding: BackupBinding): Uint8Array {
  return new TextEncoder().encode(
    `opensesame.runner-backup.v1\u0000${binding.handle}\u0000${binding.origin}`,
  );
}

interface Envelope {
  v: number;
  alg: string;
  kid: string;
  handle: string;
  origin: string;
  wk: string;
  iv: string;
  ct: string;
}

/** The envelope bytes: a fresh AES-256-GCM key wrapped to the recipient. */
export async function sealBackup(
  recipient: RecoveryRecipient,
  binding: BackupBinding,
  secret: string,
): Promise<Uint8Array> {
  const publicKey = await crypto.subtle.importKey(
    "jwk",
    recipient.jwk,
    { ...WRAP, hash: "SHA-256" },
    false,
    ["encrypt"],
  );
  const dataKey = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt"],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: aad(binding) },
      dataKey,
      new TextEncoder().encode(secret),
    ),
  );
  const wk = new Uint8Array(
    await crypto.subtle.encrypt(
      WRAP,
      publicKey,
      await crypto.subtle.exportKey("raw", dataKey),
    ),
  );
  const envelope: Envelope = {
    v: ENVELOPE_VERSION,
    alg: `${RECIPIENT_ALG}+A256GCM`,
    kid: recipient.kid,
    handle: binding.handle,
    origin: binding.origin,
    wk: b64.to(wk),
    iv: b64.to(iv),
    ct: b64.to(ct),
  };
  return new TextEncoder().encode(JSON.stringify(envelope));
}

/** The secret an envelope holds, for the person who holds the recovery key. */
export async function openBackup(
  privateJwk: JsonWebKey,
  bytes: Uint8Array,
): Promise<string> {
  const envelope: Envelope = JSON.parse(new TextDecoder().decode(bytes));
  if (envelope.v !== ENVELOPE_VERSION) throw new Error("backup_version");
  const privateKey = await crypto.subtle.importKey(
    "jwk",
    { ...privateJwk, key_ops: ["decrypt"] },
    { ...WRAP, hash: "SHA-256" },
    false,
    ["decrypt"],
  );
  const raw = await crypto.subtle.decrypt(
    WRAP,
    privateKey,
    b64.from(envelope.wk),
  );
  const dataKey = await crypto.subtle.importKey(
    "raw",
    raw,
    { name: "AES-GCM" },
    false,
    ["decrypt"],
  );
  const plain = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: b64.from(envelope.iv),
      additionalData: aad({ handle: envelope.handle, origin: envelope.origin }),
    },
    dataKey,
    b64.from(envelope.ct),
  );
  return new TextDecoder("utf-8", { fatal: true }).decode(plain);
}

/** Where a backup is put and proven: the Host's opaque ciphertext store. */
export interface BackupStore {
  /** Whether the Host accepted exactly this one blob. */
  push(id: string, bytes: Uint8Array): Promise<boolean>;
  /** Whether the Host returns exactly these bytes under `id`. */
  confirm(id: string, bytes: Uint8Array): Promise<boolean>;
}

/** The sync-store id a candidate's backup rests under. */
export function backupId(handle: string): string {
  const tail = handle
    .replace(/^candidate:/, "")
    .replace(/[^A-Za-z0-9._-]/g, "_");
  return `runner-candidate.${tail}`.slice(0, 128);
}

/**
 * Seal `secret` to the recipient, put it in the Host's store, and read it back.
 * `true` only when every one of the three happened; any refusal, any throw and
 * any mismatch is `false`, which is the answer that stops the run.
 */
export async function backUp(
  store: BackupStore,
  recipient: RecoveryRecipient,
  binding: BackupBinding,
  secret: string,
): Promise<boolean> {
  try {
    const bytes = await sealBackup(recipient, binding, secret);
    const id = backupId(binding.handle);
    if (!(await store.push(id, bytes))) return false;
    return await store.confirm(id, bytes);
  } catch {
    return false;
  }
}

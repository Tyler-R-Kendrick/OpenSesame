/** Synchronous envelopes for local Node credentials; the file root stays owner-controlled. */
import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from "node:crypto";

const PREFIX = "osle1.";
const HEADER_BYTES = 72;
const TAG_BYTES = 16;

function wrappingKey(root: Uint8Array, context: string): Buffer {
  if (root.length !== 32)
    throw new Error("Local envelope root must be 32 bytes");
  return Buffer.from(
    hkdfSync("sha256", root, "opensesame:local-envelope:v1", context, 32),
  );
}

function aad(context: string): Buffer {
  return Buffer.from(JSON.stringify(["opensesame:local-envelope:v1", context]));
}

function encrypt(
  key: Buffer,
  iv: Buffer,
  plain: Buffer,
  context: Buffer,
): Buffer {
  const cipher = createCipheriv("aes-256-gcm", key, iv, {
    authTagLength: TAG_BYTES,
  });
  cipher.setAAD(context);
  return Buffer.concat([
    cipher.update(plain),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
}

function decrypt(
  key: Buffer,
  iv: Buffer,
  packed: Buffer,
  context: Buffer,
): Buffer {
  const cipher = createDecipheriv("aes-256-gcm", key, iv, {
    authTagLength: TAG_BYTES,
  });
  cipher.setAAD(context);
  cipher.setAuthTag(packed.subarray(packed.length - TAG_BYTES));
  return Buffer.concat([
    cipher.update(packed.subarray(0, -TAG_BYTES)),
    cipher.final(),
  ]);
}

export function sealLocalEnvelope(
  root: Uint8Array,
  context: string,
  plaintext: string,
): string {
  const kek = wrappingKey(root, context);
  const dek = randomBytes(32);
  try {
    const wrapIv = randomBytes(12);
    const iv = randomBytes(12);
    const binding = aad(context);
    const wrapped = encrypt(kek, wrapIv, dek, binding);
    const header = Buffer.concat([wrapIv, wrapped, iv]);
    const payload = encrypt(
      dek,
      iv,
      Buffer.from(plaintext),
      Buffer.concat([binding, header]),
    );
    return PREFIX + Buffer.concat([header, payload]).toString("base64url");
  } finally {
    kek.fill(0);
    dek.fill(0);
  }
}

/** Authentication failure and unknown versions return null, never stored bytes. */
export function openLocalEnvelope(
  root: Uint8Array,
  context: string,
  value: string,
): string | null {
  if (!value.startsWith(PREFIX)) return null;
  let kek: Buffer | undefined;
  let dek: Buffer | undefined;
  try {
    const packed = Buffer.from(value.slice(PREFIX.length), "base64url");
    if (packed.length < HEADER_BYTES + TAG_BYTES) return null;
    kek = wrappingKey(root, context);
    const binding = aad(context);
    dek = decrypt(
      kek,
      packed.subarray(0, 12),
      packed.subarray(12, 60),
      binding,
    );
    if (dek.length !== 32) return null;
    const plain = decrypt(
      dek,
      packed.subarray(60, 72),
      packed.subarray(72),
      Buffer.concat([binding, packed.subarray(0, 72)]),
    );
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(plain);
    } finally {
      plain.fill(0);
    }
  } catch {
    return null;
  } finally {
    kek?.fill(0);
    dek?.fill(0);
  }
}

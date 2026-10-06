/**
 * The SOPS age master-key envelope (upstream `age/keysource.go`,
 * 26e2f478): the data key or a group share written through
 * `armor.NewWriter` + `age.Encrypt` for exactly one recipient. The payload
 * is the raw 32-byte key or 33-byte share; nothing OpenSesame-specific is
 * added, so upstream opens what this writes and vice versa.
 *
 * Recipients and identities are validated by their bech32 checksum and
 * shape (`bech32.ts`), never by prefix alone, so a configuration parses without
 * loading `age-encryption`; the library loads (`loadAge`) when an envelope is
 * wrapped or opened. Only X25519 identities are supported here; a plugin, SSH,
 * or other form is refused with its own diagnostic.
 */

import { loadAge } from "../../age-lib.js";
import { SopsError } from "../errors.js";
import {
  DATA_KEY_BYTES,
  MAX_AGE_PAYLOAD_BYTES,
  SHARE_BYTES,
} from "../limits.js";
import { isBech32 } from "./bech32.js";

const RECIPIENT = /^age1[02-9ac-hj-np-z]{58}$/u;
const IDENTITY = /^AGE-SECRET-KEY-1[02-9AC-HJ-NP-Z]{58}$/u;

/** Trim and validate a recipient the way upstream's parser would accept it. */
export function parseAgeRecipient(line: string): string {
  const recipient = line.trim();
  if (!RECIPIENT.test(recipient)) {
    if (recipient.startsWith("age1")) {
      throw new SopsError(
        "invalid_recipient",
        "Only X25519 age recipients are supported here.",
      );
    }
    throw new SopsError(
      "invalid_recipient",
      "A recipient is not an age recipient.",
    );
  }
  if (!isBech32(recipient, "age", 52)) {
    throw new SopsError("invalid_recipient", "A recipient did not parse.");
  }
  return recipient;
}

/** Validate an X25519 identity. The value is never logged or stored here. */
export function parseAgeIdentity(line: string): string {
  const identity = line.trim();
  if (!IDENTITY.test(identity)) {
    throw new SopsError(
      "unsupported_identity",
      "Only X25519 age identities are supported here.",
    );
  }
  if (!isBech32(identity, "AGE-SECRET-KEY-", 52)) {
    throw new SopsError("unsupported_identity", "The identity did not parse.");
  }
  return identity;
}

export async function recipientOfIdentity(identity: string): Promise<string> {
  const age = await loadAge();
  return age.identityToRecipient(parseAgeIdentity(identity));
}

function assertPayload(payload: Uint8Array): void {
  if (
    payload.byteLength !== DATA_KEY_BYTES &&
    payload.byteLength !== SHARE_BYTES
  ) {
    throw new SopsError(
      "malformed_encoding",
      "An age payload is neither a data key nor a share.",
    );
  }
}

/** Wrap a data key or share for one recipient as an armored age file. */
export async function wrapAge(
  payload: Uint8Array,
  recipient: string,
): Promise<string> {
  assertPayload(payload);
  const age = await loadAge();
  const encrypter = new age.Encrypter();
  encrypter.addRecipient(parseAgeRecipient(recipient));
  const ciphertext = await encrypter.encrypt(payload);
  const armored = age.armor.encode(ciphertext);
  return armored.endsWith("\n") ? armored : `${armored}\n`;
}

export type UnwrapResult =
  | { status: "opened"; payload: Uint8Array }
  | { status: "no_identity" }
  | { status: "malformed" };

/**
 * Try every identity against one armored envelope. Returns `no_identity`
 * when none matches; never throws on a wrong key.
 */
export async function unwrapAge(
  enc: string,
  identities: readonly string[],
): Promise<UnwrapResult> {
  if (enc.length > MAX_AGE_PAYLOAD_BYTES) return { status: "malformed" };
  const age = await loadAge();
  let decoded: Uint8Array;
  try {
    decoded = age.armor.decode(enc.trim());
  } catch {
    return { status: "malformed" };
  }
  if (identities.length === 0) return { status: "no_identity" };
  const decrypter = new age.Decrypter();
  for (const identity of identities)
    decrypter.addIdentity(parseAgeIdentity(identity));
  let payload: Uint8Array;
  try {
    payload = await decrypter.decrypt(decoded, "uint8array");
  } catch {
    return { status: "no_identity" };
  }
  if (
    payload.byteLength !== DATA_KEY_BYTES &&
    payload.byteLength !== SHARE_BYTES
  ) {
    payload.fill(0);
    return { status: "malformed" };
  }
  return { status: "opened", payload };
}

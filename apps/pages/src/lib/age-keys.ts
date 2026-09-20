/**
 * Browser-local age key SOP (FiloSottile typage / `age-encryption`).
 *
 * Age is not a Connections broker — it is the key method used when encrypting
 * sealed material (SOPS-shaped / sealed-store interop). Recipients and the
 * matching identity live sealed in the active tomb; Settings configures them.
 */

import {
  type BoundaryValue,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import * as age from "age-encryption";
import { VfsError, readFile, writeFile } from "./vfs.js";

/** Sealed VFS path holding recipients + optional identity. */
export const AGE_KEYS_CONFIG_PATH = "config/age-keys";

export type AgeKeyConfig = {
  /** Public age recipients (age1… or ssh-…). */
  recipients: string[];
  /** Private identity (`AGE-SECRET-KEY-…`); never leave the vault. */
  identity: string | null;
};

const EMPTY: AgeKeyConfig = { recipients: [], identity: null };

const RECIPIENT_LINE = /^(age1|ssh-(ed25519|rsa)\s)\S+/i;
const IDENTITY_LINE = /^AGE-SECRET-KEY-(?:PQ-)?1[A-Z0-9]+$/;

export function isAgeRecipient(line: string): boolean {
  return RECIPIENT_LINE.test(line.trim());
}

export function isAgeIdentity(line: string): boolean {
  return IDENTITY_LINE.test(line.trim());
}

function parseConfig(raw: string | null): AgeKeyConfig {
  if (!raw) return EMPTY;
  try {
    const body: BoundaryValue = JSON.parse(raw);
    if (!isJsonObject(body)) return EMPTY;
    const recipients = Array.isArray(body.recipients)
      ? body.recipients.filter(
          (row): row is string => isString(row) && isAgeRecipient(row),
        )
      : [];
    const identity =
      isString(body.identity) && isAgeIdentity(body.identity.trim())
        ? body.identity.trim()
        : null;
    return { recipients, identity };
  } catch {
    return EMPTY;
  }
}

/** Read the sealed age key SOP for this tomb (empty when missing). */
export async function readAgeKeyConfig(tomb: string): Promise<AgeKeyConfig> {
  try {
    const bytes = await readFile(tomb, AGE_KEYS_CONFIG_PATH);
    return parseConfig(new TextDecoder().decode(bytes));
  } catch (caught) {
    if (caught instanceof VfsError && caught.code === "not-found") return EMPTY;
    throw caught;
  }
}

/** Persist recipients + identity into the sealed tomb. */
export async function writeAgeKeyConfig(
  tomb: string,
  config: AgeKeyConfig,
): Promise<AgeKeyConfig> {
  const recipients = config.recipients
    .map((line) => line.trim())
    .filter(isAgeRecipient);
  const identity =
    config.identity && isAgeIdentity(config.identity.trim())
      ? config.identity.trim()
      : null;
  const next: AgeKeyConfig = { recipients, identity };
  await writeFile(
    tomb,
    AGE_KEYS_CONFIG_PATH,
    new TextEncoder().encode(JSON.stringify(next)),
  );
  return next;
}

/** Mint a fresh X25519 identity and its matching recipient via typage. */
export async function generateAgeKeyPair() {
  const identity = await age.generateIdentity();
  const recipient = await age.identityToRecipient(identity);
  return { identity, recipient };
}

/**
 * Encrypt bytes to the configured recipients (typage Encrypter).
 * Fails closed when no recipients are set.
 */
export async function encryptWithAge(
  plaintext: Uint8Array,
  recipients: readonly string[],
): Promise<Uint8Array> {
  if (recipients.length === 0) {
    throw new Error("No age recipients configured.");
  }
  const encrypter = new age.Encrypter();
  for (const recipient of recipients) {
    encrypter.addRecipient(recipient);
  }
  return encrypter.encrypt(plaintext);
}

/** Decrypt age ciphertext with the sealed identity (typage Decrypter). */
export async function decryptWithAge(
  ciphertext: Uint8Array,
  identity: string,
): Promise<Uint8Array> {
  if (!isAgeIdentity(identity)) {
    throw new Error("No age identity configured.");
  }
  const decrypter = new age.Decrypter();
  decrypter.addIdentity(identity);
  return decrypter.decrypt(ciphertext);
}

/** ASCII-armored encrypt → decrypt round-trip to prove the key SOP works. */
export async function proveAgeKeyRoundTrip(
  config: AgeKeyConfig,
): Promise<boolean> {
  if (!config.identity || config.recipients.length === 0) return false;
  const sample = new TextEncoder().encode("opensesame-age-sop");
  const cipher = await encryptWithAge(sample, config.recipients);
  const plain = await decryptWithAge(cipher, config.identity);
  return new TextDecoder().decode(plain) === "opensesame-age-sop";
}

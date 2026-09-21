/**
 * Browser-local age key inventory (FiloSottile typage / `age-encryption@0.3.1`).
 *
 * Validation goes through the library's Encrypter/Decrypter parse paths — not
 * prefix regex. Multi-identity inventory is keyed by stable id; generating a
 * new identity appends and never silently erases the only stored identity
 * (KP-25). Vault-sealed identities are post-unlock file crypto, not independent
 * root recovery (KP-26).
 */

import {
  type BoundaryValue,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import * as age from "age-encryption";
import { newOpaqueId } from "./vault/protection/ids.js";
import { VfsError, readFile, writeFile } from "./vfs.js";

/** Sealed VFS path holding recipients + optional identities. */
export const AGE_KEYS_CONFIG_PATH = "config/age-keys";

/** Where the matching private identity lives relative to vault unlock. */
export type AgeIdentityCustody =
  | "vault-sealed"
  | "external"
  | "hardware"
  | "public-only";

export type AgeIdentityEntry = {
  /** Stable inventory id — preserved across recipient-list edits. */
  id: string;
  recipient: string;
  /** Private identity when custody seals it; null for public-only grants. */
  identity: string | null;
  custody: AgeIdentityCustody;
};

export type AgeKeyConfig = {
  /** Public age recipients accepted by age-encryption (`age1…` family). */
  recipients: string[];
  /**
   * Primary sealed identity for legacy callers (AgeKeysPanel).
   * Prefer `identities` for multi-key inventory.
   */
  identity: string | null;
  identities: AgeIdentityEntry[];
};

export type AgeKeyConfigWrite = {
  recipients: string[];
  identity?: string | null;
  /** When set, replaces the inventory wholesale. Otherwise merges. */
  identities?: AgeIdentityEntry[];
};

const EMPTY: AgeKeyConfig = { recipients: [], identity: null, identities: [] };

const CUSTODY_VALUES = new Set<AgeIdentityCustody>([
  "vault-sealed",
  "external",
  "hardware",
  "public-only",
]);

/**
 * True when `line` parses as a native age recipient via Encrypter.addRecipient
 * (X25519 / hybrid / tag — whatever the pinned library accepts).
 */
export function isAgeRecipient(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  try {
    new age.Encrypter().addRecipient(trimmed);
    return true;
  } catch {
    return false;
  }
}

/**
 * True when `line` parses as a native age identity via Decrypter.addIdentity.
 */
export function isAgeIdentity(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  try {
    new age.Decrypter().addIdentity(trimmed);
    return true;
  } catch {
    return false;
  }
}

function parseCustody(value: BoundaryValue): AgeIdentityCustody | null {
  if (!isString(value)) return null;
  for (const custody of CUSTODY_VALUES) {
    if (custody === value) return custody;
  }
  return null;
}

function parseIdentityEntry(row: BoundaryValue): AgeIdentityEntry | null {
  if (!isJsonObject(row)) return null;
  if (!isString(row.id) || row.id.length === 0) return null;
  if (!isString(row.recipient) || !isAgeRecipient(row.recipient)) return null;
  const custody = parseCustody(row.custody);
  if (!custody) return null;
  const identity =
    row.identity === null || row.identity === undefined
      ? null
      : isString(row.identity) && isAgeIdentity(row.identity.trim())
        ? row.identity.trim()
        : null;
  if (custody === "vault-sealed" && !identity) return null;
  if (custody === "public-only" && identity) return null;
  return { id: row.id, recipient: row.recipient.trim(), identity, custody };
}

async function entryFromIdentitySecret(
  identitySecret: string,
  custody: AgeIdentityCustody = "vault-sealed",
): Promise<AgeIdentityEntry> {
  const identity = identitySecret.trim();
  if (!isAgeIdentity(identity)) {
    throw new Error("Invalid age identity.");
  }
  const recipient = await age.identityToRecipient(identity);
  return {
    id: newOpaqueId("ageid"),
    recipient,
    identity: custody === "public-only" ? null : identity,
    custody,
  };
}

/** Upsert by recipient; never drops other inventory rows (KP-25). */
export async function upsertAgeIdentityEntry(
  identities: readonly AgeIdentityEntry[],
  identitySecret: string,
  custody: AgeIdentityCustody = "vault-sealed",
): Promise<AgeIdentityEntry[]> {
  const next = await entryFromIdentitySecret(identitySecret, custody);
  const idx = identities.findIndex(
    (row) => row.recipient === next.recipient || row.identity === next.identity,
  );
  if (idx < 0) return [...identities, next];
  const prior = identities[idx];
  if (!prior) return [...identities, next];
  const merged: AgeIdentityEntry = {
    id: prior.id,
    recipient: next.recipient,
    identity: next.identity,
    custody: next.custody,
  };
  return identities.map((row, i) => (i === idx ? merged : row));
}

function parseConfig(raw: string | null): AgeKeyConfig {
  if (!raw) return EMPTY;
  try {
    const body: BoundaryValue = JSON.parse(raw);
    if (!isJsonObject(body)) return EMPTY;
    const recipients = Array.isArray(body.recipients)
      ? body.recipients.filter(
          (row): row is string => isString(row) && isAgeRecipient(row.trim()),
        )
      : [];
    const fromArray = Array.isArray(body.identities)
      ? body.identities
          .map(parseIdentityEntry)
          .filter((row): row is AgeIdentityEntry => row !== null)
      : [];
    const legacyIdentity =
      isString(body.identity) && isAgeIdentity(body.identity.trim())
        ? body.identity.trim()
        : null;
    let identities = fromArray;
    if (legacyIdentity) {
      const recipientMatch = identities.find(
        (row) => row.identity === legacyIdentity,
      );
      if (!recipientMatch) {
        // Legacy single-identity configs lack a recipient on the private key
        // row until the next write; keep a placeholder entry keyed by opaque id.
        identities = [
          ...identities,
          {
            id: newOpaqueId("ageid"),
            recipient: recipients[0] ?? "",
            identity: legacyIdentity,
            custody: "vault-sealed",
          },
        ];
      }
    }
    // Drop incomplete legacy placeholders that never gained a recipient.
    identities = identities.filter(
      (row) => row.recipient.length > 0 && isAgeRecipient(row.recipient),
    );
    const identity =
      legacyIdentity ??
      identities.find((row) => row.identity)?.identity ??
      null;
    return { recipients, identity, identities };
  } catch {
    return EMPTY;
  }
}

/** Read the sealed age key inventory for this tomb (empty when missing). */
export async function readAgeKeyConfig(tomb: string): Promise<AgeKeyConfig> {
  try {
    const bytes = await readFile(tomb, AGE_KEYS_CONFIG_PATH);
    return parseConfig(new TextDecoder().decode(bytes));
  } catch (caught) {
    if (caught instanceof VfsError && caught.code === "not-found") return EMPTY;
    throw caught;
  }
}

/**
 * Persist recipients + identity inventory.
 * When `identities` is omitted, a supplied `identity` is upserted into the
 * existing inventory and other identities are preserved (KP-25).
 */
export async function writeAgeKeyConfig(
  tomb: string,
  config: AgeKeyConfigWrite,
): Promise<AgeKeyConfig> {
  const existing = await readAgeKeyConfig(tomb);
  const recipients = [
    ...new Set(
      config.recipients.map((line) => line.trim()).filter(isAgeRecipient),
    ),
  ];

  let identities: AgeIdentityEntry[];
  if (config.identities) {
    identities = [];
    for (const row of config.identities) {
      const parsed = parseIdentityEntry(row);
      if (parsed) identities.push(parsed);
    }
  } else {
    identities = [...existing.identities];
    if (config.identity) {
      identities = await upsertAgeIdentityEntry(
        identities,
        config.identity,
        "vault-sealed",
      );
    }
  }

  for (const row of identities) {
    if (!recipients.includes(row.recipient) && isAgeRecipient(row.recipient)) {
      recipients.push(row.recipient);
    }
  }

  const identity =
    config.identity !== undefined && config.identity !== null
      ? config.identity.trim()
      : (identities.find((row) => row.identity)?.identity ?? null);

  const next: AgeKeyConfig = { recipients, identity, identities };
  await writeFile(
    tomb,
    AGE_KEYS_CONFIG_PATH,
    new TextEncoder().encode(JSON.stringify(next)),
  );
  return next;
}

/** Mint a fresh X25519 identity and its matching recipient via typage. */
export type AgeKeyPair = {
  identity: string;
  recipient: string;
};

export async function generateAgeKeyPair(): Promise<AgeKeyPair> {
  const identity = await age.generateX25519Identity();
  const recipient = await age.identityToRecipient(identity);
  return { identity, recipient } satisfies AgeKeyPair;
}

/**
 * Generate a new identity and append it to the sealed inventory without
 * overwriting any existing identity (KP-25).
 */
export async function appendGeneratedAgeIdentity(
  tomb: string,
): Promise<AgeKeyConfig> {
  const pair = await generateAgeKeyPair();
  const existing = await readAgeKeyConfig(tomb);
  const identities = await upsertAgeIdentityEntry(
    existing.identities,
    pair.identity,
    "vault-sealed",
  );
  const recipients = existing.recipients.includes(pair.recipient)
    ? existing.recipients
    : [...existing.recipients, pair.recipient];
  return writeAgeKeyConfig(tomb, {
    recipients,
    identity: pair.identity,
    identities,
  });
}

/**
 * Encrypt bytes to the given recipients (typage Encrypter).
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
    if (!isAgeRecipient(recipient)) {
      throw new Error("Invalid age recipient.");
    }
    encrypter.addRecipient(recipient.trim());
  }
  return encrypter.encrypt(plaintext);
}

/** Decrypt age ciphertext with an identity (typage Decrypter). */
export async function decryptWithAge(
  ciphertext: Uint8Array,
  identity: string,
): Promise<Uint8Array> {
  if (!isAgeIdentity(identity)) {
    throw new Error("No age identity configured.");
  }
  const decrypter = new age.Decrypter();
  decrypter.addIdentity(identity.trim());
  return decrypter.decrypt(ciphertext);
}

/** ASCII payload encrypt → decrypt round-trip to prove a key SOP works. */
export async function proveAgeKeyRoundTrip(
  config: AgeKeyConfig,
): Promise<boolean> {
  if (!config.identity || config.recipients.length === 0) return false;
  const sample = new TextEncoder().encode("opensesame-age-sop");
  const cipher = await encryptWithAge(sample, config.recipients);
  const plain = await decryptWithAge(cipher, config.identity);
  return new TextDecoder().decode(plain) === "opensesame-age-sop";
}

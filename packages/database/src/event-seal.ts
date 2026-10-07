/**
 * Sealing for event rows at rest (ADR 0157).
 *
 * The audit trail, the outbox and the webhook and notification delivery queues
 * hold what happened, to whom and what was sent. Postgres keeps them as jsonb,
 * so a database dump, a replica, a backup or a read-only SQL account reads them
 * whole. Each such payload is sealed under an event key before it reaches a
 * row: AES-256-GCM, with the column named in the associated data so a value
 * copied into another table does not open.
 *
 * New payloads use `osev2`: a fresh AES-256-GCM data key seals each value,
 * and a scope-derived AES-256-GCM key wraps that data key. Both layers bind
 * the scope and purpose as associated data. Repositories include the record
 * identity in the purpose and the customer, principal or aggregate in scope.
 * The deployment root remains required; independent customer KMS roots are
 * a separate provider integration. The reader retains `osev1` compatibility.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import { type JsonObject, isString } from "@opensesame/os-domain";

/** The one key of a sealed payload. */
export const SEALED_FIELD = "$sealed";
const PREFIX = "osev1.";
const ENVELOPE_PREFIX = "osev2.";
const KEY_INFO = "opensesame:event-seal:v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** A sealed payload that does not open: a wrong key, or a row that was altered. */
export class EventSealError extends Error {
  readonly code = "event_unreadable";
  constructor(purpose: string) {
    super(`A sealed ${purpose} payload could not be opened`);
    this.name = "EventSealError";
  }
}

export interface EventSealer {
  /** Domain-separated keyed lookup for durable bearer-token indexes. */
  lookupToken(purpose: string, value: string): string;
  /** Seal a payload for the named column, e.g. `audit_events.metadata`. */
  seal(purpose: string, value: JsonObject, scope?: string): JsonObject;
  /**
   * Open a current customer-bound envelope. Legacy inputs are accepted only
   * by the explicit startup migration reader.
   */
  open(purpose: string, value: JsonObject, scope?: string): JsonObject;
  /** Explicit startup migration compatibility for plaintext and osev1. */
  openLegacyForMigration(
    purpose: string,
    value: JsonObject,
    scope?: string,
  ): JsonObject;
  /** Runtime event reads require the current customer-bound envelope. */
  openCurrent(purpose: string, value: JsonObject, scope?: string): JsonObject;
  isSealed(value: JsonObject): boolean;
}

function sealedToken(value: JsonObject): string | undefined {
  const token = value[SEALED_FIELD];
  if (
    !isString(token) ||
    !(token.startsWith(PREFIX) || token.startsWith(ENVELOPE_PREFIX))
  )
    return undefined;
  return Object.keys(value).length === 1 ? token : undefined;
}

function sealEnvelope(
  key: Buffer,
  purpose: string,
  value: JsonObject,
  scope: string,
): JsonObject {
  const kek = Buffer.from(
    hkdfSync("sha256", key, scope, "opensesame:event-envelope:v2", 32),
  );
  const dataKey = randomBytes(32);
  const aad = Buffer.from(JSON.stringify([scope, purpose]));
  const encrypt = (secret: Buffer, plain: Buffer) => {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", secret, iv, {
      authTagLength: TAG_BYTES,
    });
    cipher.setAAD(aad);
    return Buffer.concat([
      iv,
      cipher.update(plain),
      cipher.final(),
      cipher.getAuthTag(),
    ]);
  };
  try {
    const packed = Buffer.concat([
      encrypt(kek, dataKey),
      encrypt(dataKey, Buffer.from(JSON.stringify(value))),
    ]);
    return {
      [SEALED_FIELD]: `${ENVELOPE_PREFIX}${packed.toString("base64url")}`,
    };
  } finally {
    dataKey.fill(0);
    kek.fill(0);
  }
}

export function createEventSealer(secret: string): EventSealer {
  if (secret === "") throw new Error("The event sealing secret is empty");
  const key = Buffer.from(hkdfSync("sha256", secret, "", KEY_INFO, 32));

  const lookupKey = Buffer.from(
    hkdfSync("sha256", key, "", "opensesame:token-lookup:key:v1", 32),
  );

  return {
    lookupToken: (purpose, value) =>
      `oslookup1.${createHmac("sha256", lookupKey)
        .update(JSON.stringify(["opensesame:token-lookup:v1", purpose, value]))
        .digest("base64url")}`,
    isSealed: (value) => sealedToken(value) !== undefined,
    seal: (purpose, value, scope = "deployment") =>
      sealEnvelope(key, purpose, value, scope),
    open(purpose, value, scope = "deployment") {
      return this.openCurrent(purpose, value, scope);
    },
    openCurrent(purpose, value, scope = "deployment") {
      const token = sealedToken(value);
      if (token === undefined || !token.startsWith(ENVELOPE_PREFIX))
        throw new EventSealError(purpose);
      return this.openLegacyForMigration(purpose, value, scope);
    },
    openLegacyForMigration(purpose, value, scope = "deployment") {
      const token = sealedToken(value);
      if (token === undefined) {
        if (SEALED_FIELD in value) throw new EventSealError(purpose);
        return value;
      }
      if (token.startsWith(ENVELOPE_PREFIX)) {
        const packed = Buffer.from(
          token.slice(ENVELOPE_PREFIX.length),
          "base64url",
        );
        const wrappedBytes = IV_BYTES + 32 + TAG_BYTES;
        if (packed.length < wrappedBytes + IV_BYTES + TAG_BYTES)
          throw new EventSealError(purpose);
        const kek = Buffer.from(
          hkdfSync("sha256", key, scope, "opensesame:event-envelope:v2", 32),
        );
        const aad = Buffer.from(JSON.stringify([scope, purpose]));
        const decrypt = (secret: Buffer, body: Buffer) => {
          const cipher = createDecipheriv(
            "aes-256-gcm",
            secret,
            body.subarray(0, IV_BYTES),
            { authTagLength: TAG_BYTES },
          );
          cipher.setAAD(aad);
          cipher.setAuthTag(body.subarray(body.length - TAG_BYTES));
          return Buffer.concat([
            cipher.update(body.subarray(IV_BYTES, body.length - TAG_BYTES)),
            cipher.final(),
          ]);
        };
        let dataKey: Buffer | undefined;
        try {
          dataKey = decrypt(kek, packed.subarray(0, wrappedBytes));
          return JSON.parse(
            decrypt(dataKey, packed.subarray(wrappedBytes)).toString("utf8"),
          );
        } catch {
          throw new EventSealError(purpose);
        } finally {
          dataKey?.fill(0);
          kek.fill(0);
        }
      }
      const packed = Buffer.from(token.slice(PREFIX.length), "base64url");
      if (packed.length < IV_BYTES + TAG_BYTES)
        throw new EventSealError(purpose);
      try {
        const decipher = createDecipheriv(
          "aes-256-gcm",
          key,
          packed.subarray(0, IV_BYTES),
          { authTagLength: TAG_BYTES },
        );
        decipher.setAAD(Buffer.from(purpose.split(":")[0] ?? purpose));
        decipher.setAuthTag(packed.subarray(packed.length - TAG_BYTES));
        const plain = Buffer.concat([
          decipher.update(packed.subarray(IV_BYTES, packed.length - TAG_BYTES)),
          decipher.final(),
        ]).toString("utf8");
        return JSON.parse(plain);
      } catch {
        throw new EventSealError(purpose);
      }
    },
  };
}

/**
 * The secret events are sealed under: a dedicated `OPENSESAME_EVENT_KEY`, else
 * the deployment's claim pepper. Never empty and never defaulted: a database
 * with no key to seal events under refuses to start rather than store them in
 * the clear.
 */
export function eventSealSecret(env: {
  readonly [name: string]: string | undefined;
}): string | undefined {
  const dedicated = env.OPENSESAME_EVENT_KEY;
  if (dedicated !== undefined && dedicated !== "") return dedicated;
  const pepper = env.OPENSESAME_CLAIM_PEPPER;
  return pepper !== undefined && pepper !== "" ? pepper : undefined;
}

/**
 * Sealing for event rows at rest (ADR 0155).
 *
 * The audit trail, the outbox and the webhook and notification delivery queues
 * hold what happened, to whom and what was sent. Postgres keeps them as jsonb,
 * so a database dump, a replica, a backup or a read-only SQL account reads them
 * whole. Each such payload is sealed under an event key before it reaches a
 * row: AES-256-GCM, with the column named in the associated data so a value
 * copied into another table does not open.
 *
 * A sealed payload is still valid JSON in the same column: `{"$sealed":
 * "osev1.<base64url(iv | ciphertext | tag)>"}`. That keeps the schema, the
 * migrations and every query that does not read the payload as they were. The
 * key is derived by HKDF from a required secret (the claim pepper unless a
 * dedicated `OPENSESAME_EVENT_KEY` is set), so there is no new secret to lose.
 */

import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import { type JsonObject, isString } from "@opensesame/os-domain";

/** The one key of a sealed payload. */
export const SEALED_FIELD = "$sealed";
const PREFIX = "osev1.";
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
  /** Seal a payload for the named column, e.g. `audit_events.metadata`. */
  seal(purpose: string, value: JsonObject): JsonObject;
  /**
   * Open a payload. A payload an older release left in the clear is returned
   * as it is; a sealed one that fails authentication throws rather than read
   * as empty.
   */
  open(purpose: string, value: JsonObject): JsonObject;
  isSealed(value: JsonObject): boolean;
}

function sealedToken(value: JsonObject): string | undefined {
  const token = value[SEALED_FIELD];
  if (!isString(token) || !token.startsWith(PREFIX)) return undefined;
  return Object.keys(value).length === 1 ? token : undefined;
}

export function createEventSealer(secret: string): EventSealer {
  if (secret === "") throw new Error("The event sealing secret is empty");
  const key = Buffer.from(hkdfSync("sha256", secret, "", KEY_INFO, 32));

  return {
    isSealed: (value) => sealedToken(value) !== undefined,
    seal(purpose, value) {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(Buffer.from(purpose));
      const body = Buffer.concat([
        cipher.update(JSON.stringify(value), "utf8"),
        cipher.final(),
      ]);
      const packed = Buffer.concat([iv, body, cipher.getAuthTag()]);
      return { [SEALED_FIELD]: `${PREFIX}${packed.toString("base64url")}` };
    },
    open(purpose, value) {
      const token = sealedToken(value);
      if (token === undefined) return value;
      const packed = Buffer.from(token.slice(PREFIX.length), "base64url");
      if (packed.length < IV_BYTES + TAG_BYTES)
        throw new EventSealError(purpose);
      try {
        const decipher = createDecipheriv(
          "aes-256-gcm",
          key,
          packed.subarray(0, IV_BYTES),
        );
        decipher.setAAD(Buffer.from(purpose));
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

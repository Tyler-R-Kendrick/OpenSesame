import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  DurableMap,
  type SecurityMap,
  takeSecurityMap,
} from "./durable-map.js";

export const ENROLLMENT_TICKET_PURPOSE = "first_admin" as const;
export const ENROLLMENT_TICKET_TTL_MS_DEFAULT = 15 * 60_000;
export const ENROLLMENT_TICKET_TTL_MS_MAX = 60 * 60_000;
export const ENROLLMENT_TICKET_TTL_MS_MIN = 60_000;

export type EnrollmentTicketRecord = {
  id: string;
  purpose: typeof ENROLLMENT_TICKET_PURPOSE;
  expiresAt: Date;
};

export function hashEnrollmentTicket(ticket: string): string {
  return createHash("sha256").update(ticket).digest("hex");
}

export function clampEnrollmentTtlMs(ttlMs: number): number {
  if (!Number.isFinite(ttlMs)) return ENROLLMENT_TICKET_TTL_MS_DEFAULT;
  return Math.min(
    ENROLLMENT_TICKET_TTL_MS_MAX,
    Math.max(ENROLLMENT_TICKET_TTL_MS_MIN, Math.floor(ttlMs)),
  );
}

export type StoredEnrollmentTicket = {
  id: string;
  ticket: string;
  expiresAt: Date;
};

export async function storeEnrollmentTicket(
  store: SecurityMap<EnrollmentTicketRecord>,
  now: Date,
  ttlMs = ENROLLMENT_TICKET_TTL_MS_DEFAULT,
): Promise<StoredEnrollmentTicket> {
  const ticket = randomBytes(32).toString("base64url");
  const id = randomUUID();
  const expiresAt = new Date(now.getTime() + clampEnrollmentTtlMs(ttlMs));
  const record: EnrollmentTicketRecord = {
    id,
    purpose: ENROLLMENT_TICKET_PURPOSE,
    expiresAt,
  };
  const key = hashEnrollmentTicket(ticket);
  if (store instanceof DurableMap) {
    const claimed = await store.claim(key, record);
    if (!claimed) throw new Error("enrollment ticket collision");
  } else {
    if (store.has(key)) throw new Error("enrollment ticket collision");
    store.set(key, record);
  }
  return { id, ticket, expiresAt };
}

/** Atomic single-use consume. Missing, spent, or expired tickets are undefined. */
export async function consumeEnrollmentTicket(
  store: SecurityMap<EnrollmentTicketRecord>,
  ticket: string,
  now: Date,
): Promise<EnrollmentTicketRecord | undefined> {
  if (!ticket) return undefined;
  const record = await takeSecurityMap(store, hashEnrollmentTicket(ticket));
  if (!record || record.expiresAt.getTime() <= now.getTime()) return undefined;
  return record;
}

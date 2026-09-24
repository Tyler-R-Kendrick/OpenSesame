/**
 * A looked-up invite, kept for the rest of this tab (ADR 0136).
 *
 * Presenting spends the offer's one presentation, and a second present burns
 * it for everyone. So once an offer is on screen, a reload must not ask
 * again: the endpoint, the bearer and the manifest wait here, tab-scoped and
 * bounded by the offer's own expiry.
 *
 * What never waits here is the out-of-band code. The removed ceremony wrote
 * the bearer and the code into the same storage entry, which put both halves
 * of the invite within one read of anything running on the page; the code
 * is typed at the moment it is used and lives in no store at all.
 */

import {
  type BoundaryValue,
  isJsonObject,
  isNumber,
  isString,
} from "@opensesame/os-domain";
import { maybeSessionStore } from "../../ports.js";
import { normalizeApiBase } from "../urls.js";
import { isInviteToken } from "./invite.js";
import { type JoinOffer, readOffer } from "./wire.js";

const KEY = "join.pending.v2";
/** The removed ceremony's entry: bearer and code together. Never read, only erased. */
const LEGACY_KEY = "join.invite.v1";
/** Past the offer's expiry — or this, when it states none. */
const MAX_AGE_MS = 30 * 60 * 1000;

export type PendingJoin = Readonly<{
  endpoint: string;
  token: string;
  offer: JoinOffer;
}>;

type Stored = PendingJoin & { expiresAt: number };

function expiresAt(offer: JoinOffer, now: number): number {
  const cap = now + MAX_AGE_MS;
  return offer.expiresAt === null ? cap : Math.min(offer.expiresAt, cap);
}

/** The offer, back in the Host's own spelling so one reader serves both. */
function wireOffer(offer: JoinOffer) {
  return {
    id: offer.id,
    manifest_digest: offer.manifestDigest,
    expires_at:
      offer.expiresAt === null ? null : new Date(offer.expiresAt).toISOString(),
    items: offer.items.map((item) => ({
      id: item.id,
      display_name: item.displayName,
      provider_id: item.providerId,
      actions: [...item.actions],
      resources: [...item.resources],
      required: item.required,
      dependencies: [...item.dependencies],
    })),
  };
}

export function writePendingJoin(pending: PendingJoin, now = Date.now()): void {
  const stored = {
    v: 2,
    endpoint: pending.endpoint,
    token: pending.token,
    offer: wireOffer(pending.offer),
    expiresAt: expiresAt(pending.offer, now),
  };
  try {
    maybeSessionStore()?.setItem(KEY, JSON.stringify(stored));
  } catch {
    // The ceremony still finishes in one sitting.
  }
}

function parse(raw: string, now: number): Stored | null {
  const value: BoundaryValue = JSON.parse(raw);
  if (!isJsonObject(value) || value.v !== 2) return null;
  const { endpoint, token, offer } = value;
  if (!isString(endpoint) || normalizeApiBase(endpoint) !== endpoint)
    return null;
  if (!isString(token) || !isInviteToken(token)) return null;
  if (!isNumber(value.expiresAt) || value.expiresAt <= now) return null;
  return {
    endpoint,
    token,
    offer: readOffer({ offer }),
    expiresAt: value.expiresAt,
  };
}

/** The pending join, or null — an expired or malformed entry is removed. */
export function readPendingJoin(now = Date.now()): PendingJoin | null {
  const store = maybeSessionStore();
  let raw: string | null = null;
  try {
    store?.removeItem(LEGACY_KEY);
    raw = store?.getItem(KEY) ?? null;
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const stored = parse(raw, now);
    if (stored) return stored;
  } catch {
    // Fall through: whatever this was, it is not a pending join.
  }
  clearPendingJoin();
  return null;
}

export function clearPendingJoin(): void {
  try {
    maybeSessionStore()?.removeItem(KEY);
    maybeSessionStore()?.removeItem(LEGACY_KEY);
  } catch {
    // Nothing stored.
  }
}

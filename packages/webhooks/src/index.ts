/**
 * Standard Webhooks signing and verification (ADR 0046 decision 12).
 *
 * The wire convention is the Standard Webhooks one — `webhook-id`,
 * `webhook-timestamp`, `webhook-signature: v1,<base64>` over
 * `id.timestamp.payload` with HMAC-SHA256 under a `whsec_`-prefixed secret —
 * so receivers can verify with any existing Standard Webhooks library rather
 * than an OpenSesame-specific one.
 *
 * Pure functions over node:crypto, no I/O: the dispatcher that uses them and
 * the receivers that verify against them both import this one vocabulary, so
 * signing and verification cannot drift apart.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const SECRET_PREFIX = "whsec_";
export const SIGNATURE_VERSION = "v1";

/**
 * Clock skew tolerated between sender and receiver. Standard Webhooks
 * recommends five minutes; outside it a replayed delivery is refused even
 * with a valid signature.
 */
export const TIMESTAMP_TOLERANCE_SECONDS = 5 * 60;

export interface WebhookSignature {
  /** Unique per delivery; doubles as the receiver's idempotency key. */
  "webhook-id": string;
  /** Unix seconds at signing time. */
  "webhook-timestamp": string;
  /** Space-separated list of `v1,<base64>` entries. */
  "webhook-signature": string;
}

export function generateWebhookSecret(): string {
  return `${SECRET_PREFIX}${randomBytes(24).toString("base64")}`;
}

function keyBytes(secret: string): Buffer {
  if (!secret.startsWith(SECRET_PREFIX)) {
    throw new Error("webhook secret must carry the whsec_ prefix");
  }
  return Buffer.from(secret.slice(SECRET_PREFIX.length), "base64");
}

function signedContent(id: string, timestamp: string, payload: string): string {
  return `${id}.${timestamp}.${payload}`;
}

export function signWebhook(
  secret: string,
  id: string,
  timestampSeconds: number,
  payload: string,
): WebhookSignature {
  const timestamp = String(Math.floor(timestampSeconds));
  const mac = createHmac("sha256", keyBytes(secret))
    .update(signedContent(id, timestamp, payload))
    .digest("base64");
  return {
    "webhook-id": id,
    "webhook-timestamp": timestamp,
    "webhook-signature": `${SIGNATURE_VERSION},${mac}`,
  };
}

/**
 * Verify a received delivery. Refusals do not say which check failed: a
 * signature oracle that distinguishes "bad MAC" from "stale timestamp" tells
 * an attacker which forgeries are close.
 */
export function verifyWebhook(
  secret: string,
  headers: WebhookSignature,
  payload: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): boolean {
  const timestamp = Number(headers["webhook-timestamp"]);
  if (!Number.isFinite(timestamp)) return false;
  if (Math.abs(nowSeconds - timestamp) > TIMESTAMP_TOLERANCE_SECONDS) {
    return false;
  }
  const expected = createHmac("sha256", keyBytes(secret))
    .update(
      signedContent(
        headers["webhook-id"],
        headers["webhook-timestamp"],
        payload,
      ),
    )
    .digest();
  // Multiple signatures may be presented during secret rotation; any valid
  // v1 entry passes.
  return headers["webhook-signature"].split(" ").some((entry) => {
    const [version, mac] = entry.split(",", 2);
    if (version !== SIGNATURE_VERSION || !mac) return false;
    const presented = Buffer.from(mac, "base64");
    return (
      presented.length === expected.length &&
      timingSafeEqual(presented, expected)
    );
  });
}

/** GET surfaces show endpoints, never usable secrets. */
export function maskWebhookSecret(secret: string): string {
  return `${SECRET_PREFIX}…${secret.slice(-4)}`;
}

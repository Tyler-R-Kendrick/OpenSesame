/**
 * Standard Webhooks signing and verification (inlined after @opensesame/webhooks removal).
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const SECRET_PREFIX = "whsec_";
export const SIGNATURE_VERSION = "v1";
export const TIMESTAMP_TOLERANCE_SECONDS = 5 * 60;

export interface WebhookSignature {
  "webhook-id": string;
  "webhook-timestamp": string;
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

export function maskWebhookSecret(secret: string): string {
  return `${SECRET_PREFIX}…${secret.slice(-4)}`;
}

/**
 * Web Push configuration from the environment: the one reading both the
 * Identity API (which serves the public key and decides whether `native_push`
 * is offered) and the worker (which signs and sends) go through, so the two
 * processes cannot disagree about what "configured" means.
 *
 *   OPENSESAME_WEBPUSH_PUBLIC_KEY   base64url uncompressed P-256 point (65 bytes)
 *   OPENSESAME_WEBPUSH_PRIVATE_KEY  base64url private scalar (32 bytes), secret
 *   OPENSESAME_WEBPUSH_SUBJECT      `mailto:` or `https:` contact (RFC 8292 §2.1)
 *
 * No private key is "no Web Push here" and not an error: a process that only
 * serves the public key (or has nothing) cannot send. A private key that is
 * present must be usable, because a half-working signing identity fails one
 * push at a time, far from the cause: it refuses the boot instead.
 *
 * Generate the pair once with `pnpm --filter @opensesame/notification-adapters
 * generate:vapid`.
 */

import { createECDH } from "node:crypto";

import { P256_UNCOMPRESSED_LENGTH } from "./adapters/web-push-ece.js";
import {
  type VapidIdentity,
  vapidConfigured,
} from "./adapters/web-push-vapid.js";
import { base64UrlDecode } from "./bytes.js";

export const WEBPUSH_PUBLIC_KEY_ENV = "OPENSESAME_WEBPUSH_PUBLIC_KEY";
export const WEBPUSH_PRIVATE_KEY_ENV = "OPENSESAME_WEBPUSH_PRIVATE_KEY";
export const WEBPUSH_SUBJECT_ENV = "OPENSESAME_WEBPUSH_SUBJECT";

const BASE64URL = /^[A-Za-z0-9_-]+$/u;
const P256_SCALAR_LENGTH = 32;

export class WebPushConfigError extends Error {
  override readonly name = "WebPushConfigError";
}

/** The slice of `process.env` Web Push reads. */
export type WebPushEnv = Readonly<Record<string, string | undefined>>;

function read(env: WebPushEnv, name: string): string {
  return (env[name] ?? "").trim();
}

/**
 * Is `value` a base64url P-256 point a browser could be told to subscribe
 * with? Canonical encoding, 65 bytes, uncompressed, on the curve.
 */
export function isVapidPublicKey(value: string): boolean {
  if (!BASE64URL.test(value)) return false;
  const point = base64UrlDecode(value);
  if (point.length !== P256_UNCOMPRESSED_LENGTH || point[0] !== 0x04) {
    return false;
  }
  try {
    const probe = createECDH("prime256v1");
    probe.generateKeys();
    probe.computeSecret(point);
    return true;
  } catch {
    return false;
  }
}

/**
 * The public key to serve, if one is set. A malformed one refuses the boot:
 * every browser that subscribed under it would hold a subscription no push
 * service could ever accept a message for.
 */
export function readVapidPublicKey(env: WebPushEnv): string {
  const publicKey = read(env, WEBPUSH_PUBLIC_KEY_ENV);
  if (publicKey && !isVapidPublicKey(publicKey)) {
    throw new WebPushConfigError(
      `${WEBPUSH_PUBLIC_KEY_ENV} is not a base64url uncompressed P-256 point (65 bytes)`,
    );
  }
  return publicKey;
}

/**
 * The signing identity, or `undefined` when this process has no private key.
 * Throws `WebPushConfigError` for one that is present and unusable.
 */
export function loadVapidIdentity(env: WebPushEnv): VapidIdentity | undefined {
  const vapidPublicKey = readVapidPublicKey(env);
  const vapidPrivateKey = read(env, WEBPUSH_PRIVATE_KEY_ENV);
  if (!vapidPrivateKey) return undefined;
  if (!vapidPublicKey) {
    throw new WebPushConfigError(
      `${WEBPUSH_PRIVATE_KEY_ENV} is set but ${WEBPUSH_PUBLIC_KEY_ENV} is not: browsers subscribe under the public key`,
    );
  }
  if (
    !BASE64URL.test(vapidPrivateKey) ||
    base64UrlDecode(vapidPrivateKey).length !== P256_SCALAR_LENGTH
  ) {
    throw new WebPushConfigError(
      `${WEBPUSH_PRIVATE_KEY_ENV} is not a base64url P-256 private scalar (32 bytes)`,
    );
  }
  const vapidSubject = read(env, WEBPUSH_SUBJECT_ENV);
  if (!/^(?:mailto:|https:)\S+$/u.test(vapidSubject)) {
    throw new WebPushConfigError(
      `${WEBPUSH_SUBJECT_ENV} must be a mailto: or https: contact (RFC 8292): push services use it to reach the operator`,
    );
  }
  const identity = { vapidPublicKey, vapidPrivateKey, vapidSubject };
  if (!vapidConfigured(identity)) {
    throw new WebPushConfigError(
      `${WEBPUSH_PRIVATE_KEY_ENV} does not match ${WEBPUSH_PUBLIC_KEY_ENV}: tokens signed with it would be refused under the key browsers subscribed with`,
    );
  }
  return identity;
}

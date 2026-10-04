import { type ECDH, createECDH, randomBytes } from "node:crypto";

/**
 * A browser-shaped Web Push subscription, with the half a browser keeps.
 *
 * `keys` is what `PushSubscription.toJSON()` produces and what the Identity API
 * accepts: a real P-256 public point and a real 16-byte auth secret, base64url
 * and unpadded. `ecdh` and `authSecret` are the user agent's private side — the
 * only way to read what was encrypted to this subscription, which is why the
 * stand-in push service needs them and no server ever has them.
 */
export interface MintedPushSubscription {
  /** Opaque id; the last path segment of `endpoint`. */
  id: string;
  /** `<endpointOrigin>/send/<id>`. A capability URL, like a real one. */
  endpoint: string;
  keys: { p256dh: string; auth: string };
  ecdh: ECDH;
  authSecret: Buffer;
}

export interface MintOptions {
  /**
   * Origin to put in the endpoint. Defaults to a public-looking host that
   * passes the adapter's SSRF fence (HTTPS, not loopback, not private); the
   * stand-in's `fetchImpl` is what maps it back to a local port.
   */
  endpointOrigin?: string;
}

export const STAND_IN_PUSH_ORIGIN = "https://push.standin.example.test";

export function mintPushSubscription(
  options: MintOptions = {},
): MintedPushSubscription {
  const origin = options.endpointOrigin ?? STAND_IN_PUSH_ORIGIN;
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const authSecret = randomBytes(16);
  const id = randomBytes(9).toString("base64url");
  return {
    id,
    endpoint: `${origin}/send/${id}`,
    keys: {
      p256dh: ecdh.getPublicKey().toString("base64url"),
      auth: authSecret.toString("base64url"),
    },
    ecdh,
    authSecret,
  };
}

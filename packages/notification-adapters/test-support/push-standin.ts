/**
 * A stand-in Web Push service, for tests and for `verify:push`.
 *
 * It plays the part of FCM / Mozilla autopush / Apple: an HTTP endpoint that
 * receives RFC 8030 pushes, and it checks each one with libraries that share no
 * code with the adapter under test — `jws` for the RFC 8292 VAPID token and
 * `http_ece` for the RFC 8291 `aes128gcm` body. An adapter that merely agrees
 * with itself cannot pass.
 *
 * What it checks, per request (a failure is recorded and answered, never
 * thrown, so the test sees what the adapter sent):
 *   - the subscription id in the path was registered here          (404)
 *   - `Authorization: vapid t=<jwt>, k=<key>`: `k` is the application server
 *     key the Identity API serves, the ES256 signature verifies under it,
 *     `aud` is this service's public origin, `exp` is in the future and within
 *     24h, `sub` is mailto: or https:                              (401)
 *   - `Content-Encoding: aes128gcm`, and the body decrypts with the registered
 *     subscription's private key and auth secret                    (400)
 *   - the plaintext is exactly the service worker's closed vocabulary
 *     `{kind, action, ref?}` (`contract`, on by default)            (400)
 * and answers 201 with a `Location` header, as real services do. `respondWith`
 * forces a status for one subscription, which is how a test gets a 404/410
 * (subscription gone) or a 503 (try again) out of the same service.
 *
 * API (everything else is internal):
 *
 *   const standIn = await startPushStandIn({ vapidPublicKey });
 *   const sub = standIn.mint();          // real P-256 key + auth secret, registered;
 *                                        // sub.endpoint is https://push.standin.example.test/send/<id>
 *   adapter = createWebPushAdapter({ ..., fetchImpl: standIn.fetchImpl });
 *   const push = await standIn.next();   // the next accepted push (or throws on timeout)
 *   push.json                            // the decrypted payload, parsed
 *   standIn.received                     // every request, accepted or refused, in order
 *   standIn.respondWith(sub.id, 410);    // that subscription is now gone
 *   await standIn.close();
 *
 * The endpoint host is deliberately a public-looking name, because the adapter
 * refuses http, loopback and private hosts even when `fetchImpl` is injected.
 * `fetchImpl` maps that origin onto the local listener and refuses any other.
 */

import { createPublicKey } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import ece from "http_ece";
import jws from "jws";

import {
  type MintOptions,
  type MintedPushSubscription,
  STAND_IN_PUSH_ORIGIN,
  mintPushSubscription,
} from "./subscription.js";

export interface PushStandInOptions {
  /** The VAPID application server key (base64url P-256 point) the pushes must be signed under. */
  vapidPublicKey: string;
  /** Expected VAPID `aud` and the origin `mint()` puts in endpoints. */
  publicOrigin?: string;
  /** Require the payload to be exactly the service worker's vocabulary. Default true. */
  contract?: boolean;
}

export interface VapidClaims {
  aud: string;
  exp: number;
  sub: string;
}

export interface AcceptedPush {
  ok: true;
  subscriptionId: string;
  vapid: { publicKey: string; claims: VapidClaims };
  ttl: string | undefined;
  urgency: string | undefined;
  /** The decrypted body, as text. */
  payload: string;
  /** The decrypted body, parsed. */
  json: unknown;
}

export interface RefusedPush {
  ok: false;
  status: number;
  reason: string;
  subscriptionId: string | undefined;
}

export type ReceivedPush = AcceptedPush | RefusedPush;

export interface PushStandIn {
  /** `http://127.0.0.1:<port>` — the listener behind `publicOrigin`. */
  readonly url: string;
  readonly publicOrigin: string;
  /** `fetch` for the adapter: `publicOrigin` URLs go to the listener, others are refused. */
  readonly fetchImpl: typeof fetch;
  /** Mint a real subscription at `publicOrigin` and register it. */
  mint(options?: MintOptions): MintedPushSubscription;
  register(subscription: MintedPushSubscription): void;
  unregister(id: string): void;
  /** Force a status for one subscription; `undefined` goes back to verifying. */
  respondWith(id: string, status: number | undefined): void;
  readonly received: readonly ReceivedPush[];
  /** The next accepted push; rejects after `timeoutMs` (default 10s). */
  next(timeoutMs?: number): Promise<AcceptedPush>;
  close(): Promise<void>;
}

const PUSH_PATH = /^\/send\/([\w-]+)$/u;
const VAPID_HEADER = /^vapid t=([^,\s]+),\s*k=([\w-]+)$/u;
const WAKE_KINDS = [
  "authorization_request",
  "authorization_decision",
  "security_event",
];
const WAKE_ACTIONS = ["review", "decided", "none"];
const OPAQUE_REF = /^[A-Za-z0-9_-]{1,128}$/u;
const MAX_VAPID_LIFETIME_SECONDS = 24 * 60 * 60;

/**
 * Why a payload is not the service worker's closed vocabulary, if it is not:
 * `{kind, action}` from the two fixed lists, plus an opaque `ref` when there is
 * one, and no other key.
 */
export function wakePayloadViolation(json: unknown): string | undefined {
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    return "payload is not an object";
  }
  const keys = Object.keys(json);
  const extra = keys.filter((key) => !["kind", "action", "ref"].includes(key));
  if (extra.length > 0) return `unexpected keys: ${extra.join(",")}`;
  const { kind, action, ref } = json as Record<string, unknown>;
  if (typeof kind !== "string" || !WAKE_KINDS.includes(kind)) {
    return "kind is not in the worker's title table";
  }
  if (typeof action !== "string" || !WAKE_ACTIONS.includes(action)) {
    return "action is not in the worker's body table";
  }
  if (ref !== undefined && !(typeof ref === "string" && OPAQUE_REF.test(ref))) {
    return "ref is not opaque";
  }
  return undefined;
}

function verifyVapid(
  authorization: string,
  vapidPublicKey: string,
  audience: string,
): { claims: VapidClaims } | { status: number; reason: string } {
  const match = VAPID_HEADER.exec(authorization);
  if (!match) return { status: 401, reason: "bad_authorization_header" };
  const [, jwt = "", key = ""] = match;
  if (key !== vapidPublicKey) return { status: 401, reason: "k_mismatch" };
  const point = Buffer.from(key, "base64url");
  const pem = createPublicKey({
    key: {
      kty: "EC",
      crv: "P-256",
      x: point.subarray(1, 33).toString("base64url"),
      y: point.subarray(33, 65).toString("base64url"),
    },
    format: "jwk",
  }).export({ type: "spki", format: "pem" });
  if (!jws.verify(jwt, "ES256", pem)) {
    return { status: 401, reason: "jwt_signature_invalid" };
  }
  const claims = JSON.parse(
    Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString("utf8"),
  ) as Partial<VapidClaims>;
  if (claims.aud !== audience) {
    return { status: 401, reason: `aud_mismatch:${String(claims.aud)}` };
  }
  const now = Date.now() / 1000;
  const exp = claims.exp ?? 0;
  if (!(exp > now && exp - now <= MAX_VAPID_LIFETIME_SECONDS)) {
    return { status: 401, reason: "exp_invalid" };
  }
  const subject = claims.sub ?? "";
  if (!/^(?:mailto:|https:)/u.test(subject)) {
    return { status: 401, reason: "sub_invalid" };
  }
  return { claims: { aud: claims.aud, exp, sub: subject } };
}

export async function startPushStandIn(
  options: PushStandInOptions,
): Promise<PushStandIn> {
  const publicOrigin = options.publicOrigin ?? STAND_IN_PUSH_ORIGIN;
  const checkContract = options.contract ?? true;
  const subscriptions = new Map<string, MintedPushSubscription>();
  const forced = new Map<string, number>();
  const received: ReceivedPush[] = [];
  const waiters: Array<(push: AcceptedPush) => void> = [];

  const handle = (
    req: http.IncomingMessage,
    body: Buffer,
  ): { status: number; push: ReceivedPush; location?: string } => {
    const refuse = (status: number, reason: string, id?: string) => ({
      status,
      push: { ok: false as const, status, reason, subscriptionId: id },
    });
    const id = PUSH_PATH.exec(req.url ?? "")?.[1];
    if (req.method !== "POST" || !id) return refuse(404, "no_route");
    const forcedStatus = forced.get(id);
    if (forcedStatus !== undefined) {
      return refuse(forcedStatus, `forced_${forcedStatus}`, id);
    }
    const subscription = subscriptions.get(id);
    if (!subscription) return refuse(404, "unknown_subscription", id);

    const vapid = verifyVapid(
      req.headers.authorization ?? "",
      options.vapidPublicKey,
      publicOrigin,
    );
    if ("status" in vapid) return refuse(vapid.status, vapid.reason, id);
    if (req.headers["content-encoding"] !== "aes128gcm") {
      return refuse(400, "content_encoding", id);
    }
    let plaintext: Buffer;
    try {
      plaintext = ece.decrypt(body, {
        version: "aes128gcm",
        privateKey: subscription.ecdh,
        authSecret: subscription.authSecret.toString("base64url"),
      });
    } catch (error) {
      const why = error instanceof Error ? error.message : "unknown";
      return refuse(400, `decrypt_failed:${why}`, id);
    }
    const payload = plaintext.toString("utf8");
    let json: unknown;
    try {
      json = JSON.parse(payload);
    } catch {
      return refuse(400, "payload_not_json", id);
    }
    const violation = checkContract ? wakePayloadViolation(json) : undefined;
    if (violation) return refuse(400, `contract_violation:${violation}`, id);
    const push: AcceptedPush = {
      ok: true,
      subscriptionId: id,
      vapid: { publicKey: options.vapidPublicKey, claims: vapid.claims },
      ttl: req.headers.ttl as string | undefined,
      urgency: req.headers.urgency as string | undefined,
      payload,
      json,
    };
    return {
      status: 201,
      push,
      location: `${publicOrigin}/message/${id}-${received.length}`,
    };
  };

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const outcome = handle(req, Buffer.concat(chunks));
      received.push(outcome.push);
      res.statusCode = outcome.status;
      if (outcome.location) res.setHeader("location", outcome.location);
      res.end();
      if (outcome.push.ok) {
        for (const waiter of waiters.splice(0)) waiter(outcome.push);
      }
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const fetchImpl: typeof fetch = async (input, init) => {
    const target = new URL(
      typeof input === "string" || input instanceof URL ? input : input.url,
    );
    if (target.origin !== publicOrigin) {
      throw new TypeError(`stand-in: refusing to fetch ${target.origin}`);
    }
    return fetch(`${url}${target.pathname}${target.search}`, init);
  };

  const register = (subscription: MintedPushSubscription) => {
    subscriptions.set(subscription.id, subscription);
  };

  return {
    url,
    publicOrigin,
    fetchImpl,
    mint: (mintOptions) => {
      const subscription = mintPushSubscription({
        endpointOrigin: publicOrigin,
        ...mintOptions,
      });
      register(subscription);
      return subscription;
    },
    register,
    unregister: (id) => {
      subscriptions.delete(id);
    },
    respondWith: (id, status) => {
      if (status === undefined) forced.delete(id);
      else forced.set(id, status);
    },
    received,
    next: (timeoutMs = 10_000) =>
      new Promise<AcceptedPush>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("stand-in: no push arrived in time")),
          timeoutMs,
        );
        waiters.push((push) => {
          clearTimeout(timer);
          resolve(push);
        });
      }),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

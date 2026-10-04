/**
 * W3C Push — the standards, implemented, with no push service in the middle.
 *
 * A "push provider" is an unnecessary party. The browser already handed us
 * an endpoint, a P-256 public key and an authentication secret; RFC 8291
 * says how to encrypt a payload to that pair so that only the subscriber's
 * user agent can read it, and RFC 8292 says how to sign the request so the
 * push service knows which application server sent it. Both are `node:crypto`
 * and a few hundred bytes of framing. Paying a vendor for this would mean
 * routing every authorization prompt through somebody else's infrastructure
 * to avoid writing an HKDF.
 *
 * Two properties are worth naming because they are easy to lose:
 *
 * - **The push service never sees the payload.** It sees ciphertext, a salt
 *   and an ephemeral public key. That is what makes it acceptable for the
 *   body to exist at all on a surface we do not control — and it is still
 *   rendered at `minimal`, because a decrypted push lands on a lock screen.
 * - **No credential is ever in a URL.** The VAPID JWT travels in the
 *   `Authorization` header. Endpoints end up in logs, referrers and crash
 *   reports; a signed token in one is a signed token in all of them.
 */

import {
  type ChannelCapabilities,
  type NotificationClass,
  channelCapabilities,
} from "@opensesame/os-domain";

import { utf8 } from "../bytes.js";
import type {
  ChannelAdapter,
  ClockLike,
  DeliveryDestination,
  DeliveryOutcome,
  FetchLike,
  RenderInput,
  RenderedMessage,
  WakeAction,
  WakeSignal,
} from "../contract.js";
import { deliverToPublicEndpoint, postPublicOnly } from "../public-endpoint.js";
import { renderNotification } from "../templates.js";
import { encryptWebPushPayload } from "./web-push-ece.js";
import {
  type VapidIdentity,
  vapidAuthorization,
  vapidConfigured,
} from "./web-push-vapid.js";

export * from "./web-push-ece.js";
export * from "./web-push-vapid.js";

export const WEB_PUSH_PROVIDER_ID = "native_push";

export interface WebPushConfig extends VapidIdentity {
  fetchImpl?: FetchLike;
  now?: ClockLike;
  ttlSeconds?: number;
}

export function createWebPushAdapter(config: WebPushConfig): ChannelAdapter {
  // The endpoint is browser-supplied: public-only, pinned, no redirects.
  const post = config.fetchImpl ?? postPublicOnly;
  const now: ClockLike = config.now ?? (() => new Date());
  const ttl = config.ttlSeconds ?? 60;

  // A key pair is checked once: deriving the public point from the scalar is
  // cheap but not free, and `isConfigured` is asked on every route and tick.
  let configured: boolean | undefined;
  const isConfigured = (): boolean => {
    configured ??= vapidConfigured(config);
    return configured;
  };

  const capabilities = (): ChannelCapabilities =>
    channelCapabilities("native_push");

  const render = (input: RenderInput): RenderedMessage => ({
    ...renderNotification(input, {
      dialect: "plain",
      // A decrypted push notification is drawn on a locked screen by the
      // operating system. `minimal` is the only honest ceiling, and it is
      // passed literally so this stays true if the catalogue ever loosens.
      channelCeiling: "minimal",
    }),
    wake: wakeSignal(input.notificationClass, input.rendezvousRef),
  });

  const deliver = async (
    msg: RenderedMessage,
    dest: DeliveryDestination,
  ): Promise<DeliveryOutcome> => {
    if (dest.channel !== "native_push") {
      return { status: "permanent", error: "destination_mismatch" };
    }
    if (!isConfigured()) {
      return { status: "unconfigured", error: "no_vapid_keys" };
    }
    const subscription = dest.subscription;
    const payload = webPushPayload(msg);
    if (!payload) return { status: "permanent", error: "not_a_wake_message" };
    let body: Buffer;
    let authorization: string;
    try {
      body = encryptWebPushPayload(subscription, payload);
      authorization = vapidAuthorization(subscription.endpoint, config, now());
    } catch (err) {
      // A malformed subscription is not worth retrying: the keys will not
      // become well-formed on their own, and the row should be re-collected
      // from the browser instead.
      return {
        status: "permanent",
        error: `subscription:${err instanceof Error ? err.name : "invalid"}`,
      };
    }
    // 404 and 410 mean the subscription is gone; `classifyHttpStatus`
    // already calls those permanent, which is what retires the row. So is a
    // private or non-HTTPS endpoint, which is refused before any request.
    const headers = {
      authorization,
      "content-encoding": "aes128gcm",
      "content-type": "application/octet-stream",
      ttl: String(ttl),
      urgency: "high",
    };
    return deliverToPublicEndpoint(post, subscription.endpoint, headers, body);
  };

  // No `verifyCallback`: a push service delivers, it does not report back a
  // human action, and the os-domain catalogue says so
  // (`canReceiveAuthenticatedCallback: false`).
  return { kind: "native_push", isConfigured, capabilities, render, deliver };
}

/**
 * The service worker's closed vocabulary, which is a contract with
 * `apps/pages/src/lib/push.ts`: it reads `kind`, `action` and `ref` and
 * nothing else, selects its own title and body from fixed tables, and builds
 * the click target from `ref` alone. The server therefore sends no text of its
 * own. A title and body in the payload were never shown (the worker ignored
 * them) and would only have been one more place for request details to leak.
 */
const WAKE_ACTION_BY_CLASS = {
  authorization_request: "review",
  authorization_decision: "decided",
  security_event: "none",
} as const satisfies { readonly [cls in NotificationClass]: WakeAction };

/** The service worker's own rule for a reference it will put in a URL. */
const OPAQUE_REF = /^[A-Za-z0-9_-]{1,128}$/u;

function wakeSignal(
  notificationClass: NotificationClass,
  rendezvousRef: string | undefined,
): WakeSignal {
  const action = WAKE_ACTION_BY_CLASS[notificationClass];
  return rendezvousRef && OPAQUE_REF.test(rendezvousRef)
    ? { kind: notificationClass, action, ref: rendezvousRef }
    : { kind: notificationClass, action };
}

/**
 * The JSON the service worker receives: exactly `{kind, action, ref}`,
 * rebuilt from the validated fields so nothing else on the message can ride
 * along. Free of identifiers and request details, because it is decrypted
 * onto a device we do not control.
 */
export function webPushPayload(msg: RenderedMessage): Buffer | undefined {
  const wake = msg.wake;
  if (!wake) return undefined;
  const checked = wakeSignal(wake.kind, wake.ref);
  if (checked.action !== wake.action) return undefined;
  return utf8(JSON.stringify(checked));
}

import { createHash } from "node:crypto";
import { RegisterPushSubscriptionSchema } from "@opensesame/contracts";
import type {
  PushSubscription,
  PushSubscriptionRepository,
} from "@opensesame/database";
import {
  normalizePushEndpoint,
  pushSubscriptionRefusal,
} from "@opensesame/notification-adapters";
import type { JsonValue } from "@opensesame/os-domain";

/**
 * The rules a Web Push registration is held to before a row is written
 * (ADR 0084): what it may contain, whether it is allowed to take the endpoint,
 * and whether the principal has room for it.
 */

/**
 * Live subscriptions one principal may hold. A person has a handful of
 * browsers; anything near this is somebody pointing the shared worker at
 * endpoints that never answer, and every one of them is a request the worker
 * must wait out. Registering past it answers 409 `subscription_limit_reached`;
 * replacing a subscription already held, or unsubscribing one, never counts
 * against it.
 */
export const MAX_PUSH_SUBSCRIPTIONS_PER_PRINCIPAL = 10;

const sha256Hex = (text: string) =>
  createHash("sha256").update(text).digest("hex");

/** A registration that passed every check on its own contents. */
export interface Registration {
  /** The canonical spelling: what is stored, and what a push is sent to. */
  endpoint: string;
  digest: string;
  /** Digest of the spelling as presented, for rows written before normalization. */
  rawDigest: string;
  keys: { p256dh: string; auth: string };
  deviceLabel?: string;
}

export interface InvalidRegistration {
  invalid: { error: "invalid_request"; detail: string };
}

export function readRegistration(
  body: JsonValue,
): Registration | InvalidRegistration {
  const parsed = RegisterPushSubscriptionSchema.safeParse(body);
  if (!parsed.success) {
    return {
      invalid: { error: "invalid_request", detail: parsed.error.message },
    };
  }
  // One spelling per endpoint, so the digest the ownership rule keys on cannot
  // be sidestepped with a differently written copy of the same URL.
  const endpoint = normalizePushEndpoint(parsed.data.endpoint);
  if (!endpoint) {
    return {
      invalid: { error: "invalid_request", detail: "insecure_endpoint" },
    };
  }
  // The same policy delivery enforces, applied while the person can still be
  // told: HTTPS, no userinfo, no loopback, private or metadata host, and keys
  // that are what RFC 8291 encrypts to. A row failing any of it could never
  // be delivered to.
  const refusal = pushSubscriptionRefusal({ endpoint, keys: parsed.data.keys });
  if (refusal)
    return { invalid: { error: "invalid_request", detail: refusal } };
  return {
    endpoint,
    digest: sha256Hex(endpoint),
    rawDigest: sha256Hex(parsed.data.endpoint),
    keys: parsed.data.keys,
    ...(parsed.data.deviceLabel
      ? { deviceLabel: parsed.data.deviceLabel }
      : undefined),
  };
}

export type Admission =
  | {
      refused: "endpoint_already_registered" | "subscription_limit_reached";
    }
  | {
      /** The principal already holds this endpoint: a replacement, not a new row. */
      replacing: boolean;
      /** The caller's own pre-normalization row for the same URL, to retire. */
      legacy: PushSubscription | null;
    };

/**
 * May this principal register this endpoint? Rows written before endpoints were
 * normalized are keyed on the raw string; one the presented spelling matches is
 * still somebody's live endpoint, and is carried over if it is the caller's own.
 */
export async function admit(
  repo: PushSubscriptionRepository,
  principalId: string,
  registration: Registration,
): Promise<Admission> {
  const { digest, rawDigest } = registration;
  const found =
    rawDigest === digest ? null : await repo.findByEndpointDigest(rawDigest);
  const legacy = found && !found.disabledAt ? found : null;
  if (legacy && legacy.principalId !== principalId) {
    return { refused: "endpoint_already_registered" };
  }
  const held = await repo.listForPrincipal(principalId);
  const replacing = held.some(
    (row) => row.endpointDigest === digest || row.endpointDigest === rawDigest,
  );
  if (!replacing && held.length >= MAX_PUSH_SUBSCRIPTIONS_PER_PRINCIPAL) {
    return { refused: "subscription_limit_reached" };
  }
  return { replacing, legacy };
}

/**
 * Concurrent registrations can each pass `admit`. Count again after the write;
 * a caller that finds the principal over withdraws its own row. Two racers may
 * both back out (fail closed), but the cap is never exceeded.
 */
export async function overCap(
  repo: PushSubscriptionRepository,
  principalId: string,
): Promise<boolean> {
  return (
    (await repo.listForPrincipal(principalId)).length >
    MAX_PUSH_SUBSCRIPTIONS_PER_PRINCIPAL
  );
}

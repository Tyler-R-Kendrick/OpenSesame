/**
 * Turning an HTTP result into a retry decision.
 *
 * Shared so that every adapter retries the same things. The classification
 * is deliberately coarse and the *reason* string is deliberately not the
 * provider's: a delivery row is read by operators and forwarded to log
 * sinks, and a hostile or merely careless endpoint that can put text there
 * has found a way to write to our logs.
 */

import type { DeliveryOutcome, DeliveryStatus } from "./contract.js";

/** 408/429 and every 5xx are the server saying "later", not "no". */
export function classifyHttpStatus(status: number): DeliveryStatus {
  if (status >= 200 && status < 300) return "delivered";
  if (status === 408 || status === 429) return "retryable";
  if (status >= 500) return "retryable";
  return "permanent";
}

/**
 * A thrown fetch is a transport failure: DNS, TLS, reset, timeout. All of
 * them are worth another attempt, and none of them may carry the exception
 * message forward — `err.message` on a fetch failure can contain the URL,
 * which for several of these channels is itself a bearer credential.
 */
export function classifyThrown(err: Error | undefined): DeliveryOutcome {
  return {
    status: "retryable",
    error: `transport:${err?.name ?? "FetchError"}`,
  };
}

export function httpOutcome(status: number): DeliveryOutcome {
  const classified = classifyHttpStatus(status);
  if (classified === "delivered") return { status: "delivered" };
  return { status: classified, error: `status:${status}` };
}

/** Every provider call gets a deadline; a hung socket must not hold a worker. */
export const DELIVERY_TIMEOUT_MS = 10_000;

export function deliveryAbortSignal(): AbortSignal {
  return AbortSignal.timeout(DELIVERY_TIMEOUT_MS);
}

/**
 * An endpoint URL an operator supplied is still input.
 *
 * Several of these channels take a URL that is itself a bearer capability
 * (a Teams incoming webhook, an SMS bridge). Sending one over cleartext
 * hands it to anyone on the path, so a non-HTTPS endpoint is refused rather
 * than downgraded.
 */
export function isHttpsUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

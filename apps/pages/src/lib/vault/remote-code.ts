import { isString, overlapCast } from "@opensesame/os-domain";
import { identityBase, identityFetch } from "../identity.js";
import type { CodeChannel } from "./unlock-methods.js";

/**
 * The Identity API's part of the fallback second step: it sends a six-digit
 * code to an address and answers yes or no once. The vault never learns the
 * code ahead of time and never verifies it itself — the gate's strength is
 * the Identity session's, which is why the client says "weaker than an app"
 * before binding it, and why the authenticator stays the first tab at unlock.
 */
export type SentCode = {
  challengeId: string;
  channel: CodeChannel;
  /** Masked by the service: `t•••@example.com`, `+1 ••• ••• 0142`. */
  to: string;
  expiresAt: string;
};

export class RemoteCodeError extends Error {
  override readonly name = "RemoteCodeError";
  constructor(
    readonly reason:
      | "no_identity"
      | "not_configured"
      | "too_many"
      | "delivery_failed"
      | "invalid_code"
      | "challenge_spent"
      | "unauthorized",
    message: string,
  ) {
    super(message);
  }
}

/** Whether there is an Identity API to send through at all. */
function requireIdentity(): void {
  if (!identityBase()) {
    throw new RemoteCodeError(
      "no_identity",
      "Codes by email or text need an Identity API. Set one under Settings → Connectivity.",
    );
  }
}

async function sendCodeDefault(
  channel: CodeChannel,
  to: string,
): Promise<SentCode> {
  requireIdentity();
  const res = await identityFetch("/v1/mfa/code/send", {
    method: "POST",
    body: JSON.stringify({ channel, to }),
  });
  const body = overlapCast(await res.json().catch(() => ({})));
  if (res.ok && isString(body.challengeId) && isString(body.to)) {
    return {
      challengeId: body.challengeId,
      channel,
      to: body.to,
      expiresAt: isString(body.expiresAt) ? body.expiresAt : "",
    };
  }
  if (res.status === 401 || res.status === 403) {
    throw new RemoteCodeError(
      "unauthorized",
      "Sign in to the Identity API first; it sends the code on your behalf.",
    );
  }
  if (res.status === 503) {
    throw new RemoteCodeError(
      "not_configured",
      channel === "email"
        ? "The Identity API has no mail transport configured, so it cannot send an email code."
        : "The Identity API has no SMS bridge configured, so it cannot send a text.",
    );
  }
  if (res.status === 429) {
    throw new RemoteCodeError(
      "too_many",
      "Too many codes were sent recently. Use one you already have, or wait ten minutes.",
    );
  }
  throw new RemoteCodeError(
    "delivery_failed",
    channel === "email"
      ? "The email could not be sent. Check the address and try again."
      : "The text could not be sent. Check the number and try again.",
  );
}

async function verifyCodeDefault(
  challengeId: string,
  code: string,
): Promise<void> {
  requireIdentity();
  const res = await identityFetch("/v1/mfa/code/verify", {
    method: "POST",
    body: JSON.stringify({ challengeId, code }),
  });
  if (res.ok) return;
  const body = overlapCast(await res.json().catch(() => ({})));
  if (body.error === "challenge_spent") {
    throw new RemoteCodeError(
      "challenge_spent",
      "Five wrong codes; that one is spent. Send a new code and enter it.",
    );
  }
  if (res.status === 401 && body.error !== "invalid_code") {
    throw new RemoteCodeError(
      "unauthorized",
      "Sign in to the Identity API first; it checks the code on your behalf.",
    );
  }
  throw new RemoteCodeError(
    "invalid_code",
    "That code did not match. Codes are good for ten minutes; use the newest one you were sent.",
  );
}

/** Test seam: the two calls a code takes, swapped for fakes in unit tests. */
export const remoteCodeSeams = {
  sendCode: sendCodeDefault,
  verifyCode: verifyCodeDefault,
};

export function sendCode(channel: CodeChannel, to: string): Promise<SentCode> {
  return remoteCodeSeams.sendCode(channel, to);
}

export function verifyCode(challengeId: string, code: string): Promise<void> {
  return remoteCodeSeams.verifyCode(challengeId, code);
}

/**
 * One-time, user-initiated permission to hand a matched reset message to the
 * Host. An email chooses the login and site, but it must never be enough on
 * its own: the person has to press the notice's action first. The random
 * nonce is the outstanding-request state consumed by the hand-off, so a
 * replayed or attacker-sent message cannot rotate a credential by itself.
 */

export const RESET_AUTHORIZATION_TTL_MS = 5 * 60_000;

export type ResetHandoffRequest = {
  itemId: string;
  origin: string;
  messageId: string;
};

type Authorization = ResetHandoffRequest & {
  nonce: string;
  expiresAt: number;
};

const authorizations = new Map<string, Authorization>();

function keyOf(request: ResetHandoffRequest): string {
  return `${request.itemId}\n${request.origin}\n${request.messageId}`;
}

/** The person pressed the reset action for this exact match. */
export function authorizeResetHandoff(
  request: ResetHandoffRequest,
  now = Date.now(),
): string {
  const nonce = [...crypto.getRandomValues(new Uint8Array(16))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  authorizations.set(keyOf(request), {
    ...request,
    nonce,
    expiresAt: now + RESET_AUTHORIZATION_TTL_MS,
  });
  return nonce;
}

/**
 * Consume the approval for this match. Returns the nonce it carried, or null
 * when there is no live user-initiated request to correlate the mail with.
 */
export function consumeResetHandoffAuthorization(
  request: ResetHandoffRequest,
  now = Date.now(),
): string | null {
  const key = keyOf(request);
  const found = authorizations.get(key);
  if (!found) return null;
  authorizations.delete(key);
  return found.expiresAt > now ? found.nonce : null;
}

export function resetResetHandoffAuthorizationsForTest(): void {
  authorizations.clear();
}

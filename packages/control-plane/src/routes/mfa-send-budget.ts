import { createHash } from "node:crypto";
import { type SecurityMap, updateSecurityMap } from "../repos/durable-map.js";
import type { MfaCodeSendWindow } from "../state.js";

/**
 * The send budget for `/v1/mfa/code/send`.
 *
 * Every send is an email or a text somebody pays for, to an address the caller
 * typed — and the caller may be an anonymous provisional principal. Capping
 * only LIVE challenges let a caller burn each one with five wrong codes and
 * send again at once, which made the route an unlimited SMS/email relay (toll
 * fraud, harassment). The budget therefore counts SENDS over a rolling hour,
 * per principal and per destination, and nothing gives a send back: not a
 * spent challenge, not an expired one, not a verified one.
 *
 * The windows live in a `SecurityMap`, so a database-backed deployment keeps
 * them in the same durable key-value table as the challenges themselves
 * (`installDurableSecurityMaps`), and a restart does not reset them. A
 * destination is keyed by a digest, never the address itself.
 */

export const CODE_SEND_WINDOW_MS = 60 * 60_000;
export const CODE_SENDS_PER_PRINCIPAL = 5;
export const CODE_SENDS_PER_DESTINATION = 5;

function destinationKey(channel: "email" | "sms", to: string): string {
  const normalized = channel === "email" ? to.toLowerCase() : to;
  const digest = createHash("sha256")
    .update(`${channel}:${normalized}`)
    .digest("hex");
  return `destination:${digest}`;
}

/** Record one send under `key`, unless its window is already full. */
async function charge(
  store: SecurityMap<MfaCodeSendWindow>,
  key: string,
  limit: number,
  now: number,
): Promise<boolean> {
  let admitted = false;
  await updateSecurityMap(store, key, (current) => {
    const live = (current?.sentAt ?? []).filter(
      (at) => now - at < CODE_SEND_WINDOW_MS,
    );
    admitted = live.length < limit;
    if (admitted) live.push(now);
    // The row lives as long as its newest send still counts.
    const newest = live.at(-1) ?? now;
    return { sentAt: live, expiresAt: newest + CODE_SEND_WINDOW_MS };
  });
  return admitted;
}

/**
 * Charge a send against the principal and the destination. `false` means the
 * code must not be sent. The principal is charged first: a caller cycling
 * through destinations runs out of its own budget before anybody else's.
 */
export async function chargeCodeSend(
  store: SecurityMap<MfaCodeSendWindow>,
  principalId: string,
  channel: "email" | "sms",
  to: string,
  now: number,
): Promise<boolean> {
  if (
    !(await charge(
      store,
      `principal:${principalId}`,
      CODE_SENDS_PER_PRINCIPAL,
      now,
    ))
  ) {
    return false;
  }
  return charge(
    store,
    destinationKey(channel, to),
    CODE_SENDS_PER_DESTINATION,
    now,
  );
}

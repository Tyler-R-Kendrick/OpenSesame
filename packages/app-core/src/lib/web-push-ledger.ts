/**
 * What this browser remembers about its push enrolment: the id the Identity
 * API gave its subscription (so it can be withdrawn by id, never by the
 * endpoint, which is a capability URL), and the ids it has stopped using but
 * the Identity API may still list.
 *
 * Shared by the worker controller, which retires the id when the push worker
 * goes away, and the page's enrolment code, which forgets the pending ones
 * when a session and the capability are there to do it with. Ids only: nothing
 * here is an endpoint, a key or a token.
 */

import { kvDelete, kvGet, kvHydrate, kvSet } from "./kv.js";

/** The id the Identity API gave this browser's current subscription. */
export const PUSH_SUBSCRIPTION_KEY = "push.subscription.id";

/** Ids the Identity API may still list that this browser no longer holds. */
export const PUSH_PENDING_FORGET_KEY = "push.forget.pending";

/** Both keys, read into memory before they are read. */
export function hydratePushLedger(): Promise<void> {
  return kvHydrate([PUSH_SUBSCRIPTION_KEY, PUSH_PENDING_FORGET_KEY]);
}

/** An opaque id and nothing that could split the list or name a URL. */
const OPAQUE_ID = /^[A-Za-z0-9_.-]{1,128}$/;

export function pendingPushForgets(): readonly string[] {
  return (kvGet(PUSH_PENDING_FORGET_KEY) ?? "")
    .split("\n")
    .filter((id) => OPAQUE_ID.test(id));
}

function writePending(ids: readonly string[]): void {
  if (ids.length === 0) kvDelete(PUSH_PENDING_FORGET_KEY);
  else kvSet(PUSH_PENDING_FORGET_KEY, ids.join("\n"));
}

/** Remember an id to tell the Identity API to forget; idempotent. */
export function addPendingPushForget(id: string): void {
  if (!OPAQUE_ID.test(id)) return;
  const pending = pendingPushForgets();
  if (!pending.includes(id)) writePending([...pending, id]);
}

/** The Identity API has forgotten this id (or never knew it). */
export function clearPendingPushForget(id: string): void {
  const pending = pendingPushForgets();
  if (pending.includes(id)) writePending(pending.filter((p) => p !== id));
}

/**
 * The push capability is gone and so is the browser's subscription: the
 * stored id moves to the pending list, to be forgotten when a session is
 * available, and the current-id slot is emptied so nothing reads it as live.
 */
export async function retirePushSubscriptionId(): Promise<void> {
  await hydratePushLedger();
  const id = kvGet(PUSH_SUBSCRIPTION_KEY);
  if (id) addPendingPushForget(id);
  kvDelete(PUSH_SUBSCRIPTION_KEY);
}

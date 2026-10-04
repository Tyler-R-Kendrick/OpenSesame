/**
 * The device's inbox: requests waiting for the person who holds this vault
 * (ADR 0162).
 *
 * What waits here is a sealed local access request (ADR 0111) that has not
 * been decided and has not expired. It is decided where it always was —
 * Access › Requests, with the person's passkey bound to the request, the
 * decision and the approver — and nothing in this file can decide one. A row
 * is the closed contract `{ kind, action, ref }` plus its expiry: no
 * application name, no scope, no reason, no callback address. That is also all
 * a notification may carry (ADR 0084), so a row can be handed to any
 * destination without a content decision.
 *
 * A sign-in whose consent window is open is not queued here, whether the
 * window has been approved yet or not (`isSignInInFlight`). That ceremony
 * holds a port to the relying party's window that no other tab can answer, so
 * it is decided in its own window and recorded as a receipt, not as a row; and
 * the window withdraws what it raised if it ends before it is decided.
 */

import {
  LocalDirectoryError,
  withLocalDirectoryLock,
} from "./local-directory.js";
import {
  currentRequest,
  readLocalRequestRecords,
} from "./local-request-store.js";
import { isSignInInFlight } from "./local-request-summary.js";
import { tombUnlocked } from "./vfs.js";

/**
 * How long to wait before reading the inbox again after a read failed, one
 * delay per retry and no more retries than delays. A read that fails once is
 * usually a lock someone else held a moment too long; one that keeps failing is
 * a vault that is shut, which says so and is not asked again until something
 * changes.
 */
export const READ_RETRY_DELAYS_MS: readonly number[] = [1000, 2000, 4000, 8000];

/** What kind of thing is waiting. A closed set. */
export type InboxKind = "local-access";

/** What the person is being asked to do with it. A closed set. */
export type InboxAction = "review";

export type InboxRow = Readonly<{
  kind: InboxKind;
  action: InboxAction;
  /** The request's id: a handle, not a bearer. It authorizes nothing. */
  ref: string;
  /** When the request lapses, as an ISO instant. */
  expiresAt: string;
}>;

/**
 * Requests awaiting a decision, newest first. Reads the sealed records, so it
 * throws while the vault is shut: an empty list would say "nothing waiting",
 * which a locked device cannot know.
 */
export async function listInbox(
  tomb: string,
  now: number = Date.now(),
): Promise<InboxRow[]> {
  // The same fence Access › Requests reads under, over the same sealed
  // records. They are read directly so that the module that decides a request
  // (`local-access-requests.ts`, Access's) is not pulled into the device plane
  // or a notification by a count.
  const requests = await withLocalDirectoryLock(tomb, async () => {
    const stored = await readLocalRequestRecords(tomb);
    if (!tombUnlocked(tomb))
      throw new LocalDirectoryError("The vault is locked.");
    return stored.map(currentRequest);
  });
  return requests
    .filter(
      (row) =>
        row.status === "pending" &&
        row.expiresAt > now &&
        !isSignInInFlight(row),
    )
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((row) => ({
      kind: "local-access",
      action: "review",
      ref: row.id,
      expiresAt: new Date(row.expiresAt).toISOString(),
    }));
}

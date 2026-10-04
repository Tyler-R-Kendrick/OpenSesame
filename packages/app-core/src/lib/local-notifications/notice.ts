/**
 * What a local notification carries (ADR 0162, on ADR 0084): the closed
 * contract `{ kind, action, ref }` and nothing else.
 *
 * A lock screen, a window switcher and a tab strip are all "the
 * notification". So its words are the same for every request — that one is
 * waiting, and how many — and never the application's name, a scope, a reason
 * or a callback address. The `ref` is the request's id: a handle that
 * authorizes nothing, there so a click can arrive at the right place.
 */

import {
  type BoundaryValue,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import type { InboxAction, InboxKind, InboxRow } from "../device-inbox.js";

export type LocalNotice = Readonly<{
  kind: InboxKind;
  action: InboxAction;
  ref: string;
}>;

/** The notice for a row: the three fields of the contract, copied. */
export function noticeOf(row: InboxRow): LocalNotice {
  return { kind: row.kind, action: row.action, ref: row.ref };
}

const REF = /^[0-9a-f-]{36}$/;

/**
 * A notice read back from where a browser kept it (a notification's data).
 * Anything that is not exactly the contract is nothing: a click on one reads
 * no field it did not write, and extra fields are dropped, not honored.
 */
export function parseNotice(value: BoundaryValue): LocalNotice | null {
  if (!isJsonObject(value)) return null;
  const { kind, action, ref } = value;
  if (kind !== "local-access" || action !== "review") return null;
  return isString(ref) && REF.test(ref) ? { kind, action, ref } : null;
}

/** The words for however many wait: the same whoever is asking for what. */
export function noticeWords(count: number): { title: string; body: string } {
  return count === 1
    ? { title: "Request waiting", body: "A request is waiting for you." }
    : {
        title: "Requests waiting",
        body: `${count} requests are waiting for you.`,
      };
}

/** Where a notice leads: the list the request is decided from. */
export const NOTICE_ROUTE = "/access?view=requests#local-requests";

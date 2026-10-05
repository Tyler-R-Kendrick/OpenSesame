import { itemLines } from "./inputs.js";
import type { DuressContext, DuressMode, DuressPlan } from "./mode.js";
import {
  type SharedItem,
  VISIBLE_LIMITS,
  readVisibleItemsBody,
} from "./visible-items-shape.js";
import { pickRows, shareItem } from "./visible-items-share.js";

/**
 * The plan for the items the owner left shown: a copy of each, taken from the
 * vault the owner has open, in the vault's own order. An id that names no
 * shareable item is skipped, so a stale pick can only ever hide something;
 * nothing shown means no plan. The body is read back through the same reader
 * unlock uses, so a plan that would not run is never sealed.
 */
function planFor(
  extras: Readonly<Record<string, string>>,
  context: DuressContext,
): DuressPlan {
  const shown = new Set(itemLines(extras.shown ?? ""));
  const items: SharedItem[] = [];
  for (const item of context.items) {
    if (!shown.has(item.id)) continue;
    const copy = shareItem(item);
    if (copy) items.push(copy);
  }
  if (items.length < VISIBLE_LIMITS.min || items.length > VISIBLE_LIMITS.max) {
    throw new Error("shown items out of range");
  }
  const body = { v: 1, items } as const;
  if (!readVisibleItemsBody(body)) throw new Error("shown items out of shape");
  return { effect: "visible_items", body };
}

/**
 * The decoy, holding copies of the items the owner chose to leave shown. The
 * vault stays sealed and its key is never derived from the code: the copies
 * were taken at arming, with the vault open, and sealed under the code alone.
 */
export const VISIBLE_ITEMS = {
  id: "visible_items",
  label: "Show my vault without the items I hide",
  opens: "a decoy holding copies of the items you leave shown",
  consent:
    "I understand this code opens a decoy holding copies, taken now, of only the items I leave shown, never my vault; items I add later stay hidden, and edits show their old content until I turn this on again. The copies are sealed under this short code, so anyone with this browser's storage and enough effort can read them: I choose only items I could afford to show. Passkeys, certificates, drops, files, one-time-code seeds, concealed custom fields, history, folders and deleted items are never copied.",
  presentation: "decoy",
  input: {
    kind: "pick",
    id: "shown",
    label: "Hidden items",
    min: VISIBLE_LIMITS.min,
    max: VISIBLE_LIMITS.max,
  },
  plan: planFor,
  rows: (context) => pickRows(context.items),
} as const satisfies DuressMode;

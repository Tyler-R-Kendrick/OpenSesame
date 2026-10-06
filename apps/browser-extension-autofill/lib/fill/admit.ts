/**
 * The background's half of the fill check (ADR 0150 §6.4).
 *
 * A gesture on extension-owned UI *arms* one fill: a single-use nonce bound
 * to the tab, the top frame's origin the background read from the tab
 * itself, and the reference the person chose. When a content script then
 * asks for the value, the background does not take the page's word for any
 * of it. It re-checks what the browser — not the page — says about the
 * sender: that it is this extension's own script, in frame 0 of the armed
 * tab, in a document whose origin is exactly the armed one. A nonce is spent
 * on the first attempt, whatever the outcome, so a refused try cannot be
 * retried and an admitted one cannot be replayed.
 */
import { GESTURE_WINDOW_MS, type Trigger, isWebOrigin } from "./guard";

export interface ArmRecord {
  readonly nonce: string;
  readonly tabId: number;
  readonly origin: string;
  readonly reference: string;
  readonly trigger: Trigger;
  readonly armedAt: number;
  /** Trusted worker closure, never sent to the content script. */
  readonly authorize?: () => Promise<boolean>;
}

/** What the browser reports about a message's sender. */
export interface SenderFacts {
  readonly id?: string;
  readonly tabId?: number;
  readonly frameId?: number;
  readonly origin?: string;
  readonly url?: string;
}

export type AdmitRefusal =
  | "unknown_gesture"
  | "stale_gesture"
  | "foreign_sender"
  | "not_top_frame"
  | "wrong_tab"
  | "origin_mismatch";

export type Admission =
  | { readonly ok: true; readonly record: ArmRecord }
  | { readonly ok: false; readonly refusal: AdmitRefusal };

/** The http(s) origin of a URL, or null for anything else. */
export function webOriginOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const origin = new URL(url).origin;
    return isWebOrigin(origin) ? origin : null;
  } catch {
    return null;
  }
}

/** The sender's origin: the browser's `origin` field, else its URL's. */
export function senderOrigin(sender: SenderFacts): string | null {
  if (sender.origin !== undefined) {
    return isWebOrigin(sender.origin) ? sender.origin : null;
  }
  return webOriginOf(sender.url);
}

function senderRefusal(
  record: ArmRecord,
  sender: SenderFacts,
  ownId: string,
): AdmitRefusal | null {
  if (sender.id !== ownId) return "foreign_sender";
  if (sender.frameId !== 0) return "not_top_frame";
  if (sender.tabId !== record.tabId) return "wrong_tab";
  if (senderOrigin(sender) !== record.origin) return "origin_mismatch";
  return null;
}

/** Armed gestures, each good for one attempt within the gesture window. */
export class ArmLedger {
  readonly #armed = new Map<string, ArmRecord>();
  readonly #ownId: string;

  constructor(ownId: string) {
    this.#ownId = ownId;
  }

  arm(record: ArmRecord): void {
    this.#armed.set(record.nonce, record);
  }

  /** Drop gestures that can no longer be used. */
  prune(now: number): void {
    for (const [nonce, record] of this.#armed) {
      if (now - record.armedAt > GESTURE_WINDOW_MS) this.#armed.delete(nonce);
    }
  }

  /** Spend `nonce` for `sender`, admitting it only if every check holds. */
  take(nonce: string, sender: SenderFacts, now: number): Admission {
    this.prune(now);
    const record = this.#armed.get(nonce);
    if (!record) return { ok: false, refusal: "unknown_gesture" };
    this.#armed.delete(record.nonce);
    const age = now - record.armedAt;
    if (age < 0 || age > GESTURE_WINDOW_MS) {
      return { ok: false, refusal: "stale_gesture" };
    }
    const refusal = senderRefusal(record, sender, this.#ownId);
    return refusal ? { ok: false, refusal } : { ok: true, record };
  }

  get size(): number {
    return this.#armed.size;
  }
}

/**
 * The guard in the page's top frame (ADR 0150 §6.4). The entrypoint
 * (`entrypoints/fill-guard.ts`) decodes each inbound message with `wire.ts`
 * and hands this module only an arm this extension sent. The guard checks
 * the page with `decideFill`, asks the background for the value only when
 * every check passes, and checks the page *again* when the value arrives —
 * the page had a whole round trip to swap an overlay in or move focus —
 * before writing.
 *
 * It never adds anything to the page: no overlay, no button, no listener on
 * the page's own events. The value lives in one local for the length of one
 * write and is returned to nobody.
 */
import { focusedInput, pageFacts } from "./facts";
import { decideFill } from "./guard";
import { FILL_MESSAGE } from "./protocol";
import type { ArmMessage, GuardReply, ValueReply, ValueRequest } from "./wire";
import { writeValue } from "./write";

/** Ask the background for the value; resolves to the decoded reply. */
export type RequestValue = (request: ValueRequest) => Promise<ValueReply>;

/** What the browser says sent a message to this frame. */
export interface SenderIdentity {
  readonly id?: string;
}

const INSTALLED = Symbol.for("opensesame.fill.guard");

/** Only this extension's own background may arm the guard. */
export function fromThisExtension(
  sender: SenderIdentity,
  ownId: string,
): boolean {
  return sender.id === ownId;
}

/**
 * Claim this document for one guard. The symbol lives on the isolated
 * world's view of `window`, which page script cannot see or set; a second
 * injection into the same document finds it and installs nothing.
 */
export function claimDocument(view: Window): boolean {
  if (Object.hasOwn(view, INSTALLED)) return false;
  Object.defineProperty(view, INSTALLED, { value: true });
  return true;
}

/** Answer one arm this extension sent. */
export async function answerArm(
  view: Window,
  requestValue: RequestValue,
  arm: ArmMessage,
): Promise<GuardReply> {
  const facts = pageFacts(view);
  if (arm.mode === "probe") {
    return { passkey: facts.isTopFrame && facts.passkeyOffered };
  }
  const decision = decideFill(arm, facts, Date.now());
  if (!decision.fill) return { outcome: decision.refusal };
  const input = focusedInput(view.document);
  const reply = await requestValue({
    type: FILL_MESSAGE,
    op: "value",
    nonce: arm.nonce,
    field: decision.field,
  });
  if ("refusal" in reply) return { outcome: reply.refusal };
  const again = decideFill(arm, pageFacts(view), Date.now());
  if (!again.fill) return { outcome: again.refusal };
  if (!input || focusedInput(view.document) !== input) {
    return { outcome: "focus_moved" };
  }
  if (again.field !== decision.field) return { outcome: "focus_moved" };
  writeValue(input, reply.value);
  return { outcome: "filled" };
}

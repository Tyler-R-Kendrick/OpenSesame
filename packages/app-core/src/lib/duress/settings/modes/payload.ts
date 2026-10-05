/**
 * A mode's plan, as the bytes sealed in the slot beside the presentation.
 *
 * Nothing stored says which mode an armed code is: the plan is inside the
 * ciphertext, read only after the code opens it. Decoding never throws and
 * never guesses: an unreadable, unversioned or unknown-effect payload is no
 * plan, and the code then does only what its presentation says.
 */

import { MAX_SLOT_PAYLOAD_BYTES } from "../../crypto/slot-profile.js";
import type { DuressEffectName, DuressPlan } from "./mode.js";

const EFFECTS: ReadonlySet<string> = new Set<DuressEffectName>([
  "decoy_items",
  "freeze",
  "wipe",
]);

type Envelope = Readonly<{ e: string; v: 1; b: unknown }>;

export function encodePlan(plan: DuressPlan): Uint8Array {
  const envelope: Envelope = { e: plan.effect, v: 1, b: plan.body };
  const bytes = new TextEncoder().encode(JSON.stringify(envelope));
  if (bytes.length > MAX_SLOT_PAYLOAD_BYTES) {
    throw new Error("duress plan is too large");
  }
  return bytes;
}

export function decodePlan(
  bytes: Uint8Array | null | undefined,
): DuressPlan | null {
  if (!bytes || bytes.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (typeof parsed !== "object" || parsed === null) return null;
    const { e, v, b } = parsed as Partial<Envelope>;
    if (v !== 1 || typeof e !== "string" || !EFFECTS.has(e)) return null;
    return { effect: e as DuressEffectName, body: b };
  } catch {
    return null;
  }
}

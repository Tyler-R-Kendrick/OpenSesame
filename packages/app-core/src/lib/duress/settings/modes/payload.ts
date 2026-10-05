/**
 * A mode's plan, as the bytes sealed in the slot beside the presentation.
 *
 * Nothing stored says which mode an armed code is: the plan is inside the
 * ciphertext, read only after the code opens it. Decoding never throws and
 * never guesses: an unreadable, unversioned or unknown-effect payload is no
 * plan, and the code then does only what its presentation says.
 */

import {
  type JsonValue,
  isString,
  readJsonObject,
} from "@opensesame/os-domain";
import { MAX_SLOT_PAYLOAD_BYTES } from "../../crypto/slot-profile.js";
import type { DuressEffectName, DuressPlan } from "./mode.js";

const EFFECTS: ReadonlyMap<string, DuressEffectName> = new Map(
  (["decoy_items", "freeze", "wipe"] as const).map((name) => [name, name]),
);

type Envelope = Readonly<{ e: string; v: 1; b: JsonValue }>;

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
    const parsed = readJsonObject(JSON.parse(new TextDecoder().decode(bytes)));
    if (!parsed || parsed.v !== 1 || !isString(parsed.e)) return null;
    const effect = EFFECTS.get(parsed.e);
    if (!effect) return null;
    return { effect, body: parsed.b ?? null };
  } catch {
    return null;
  }
}

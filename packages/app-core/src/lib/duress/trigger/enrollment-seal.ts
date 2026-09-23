/**
 * Seal and open one enrolled trigger's slot by kind (TRIGGER-A/B, KEYS-E).
 *
 * `prf_and_code` is two-layered: the code-sealed profile slot is sealed again
 * under the passkey's PRF output and the code (`sealPrfAndCode`), and the
 * stored slot keeps its metadata only. The code alone opens nothing, and a
 * PRF output from any other passkey (or random bytes) opens nothing either.
 */

import { b64, fromB64 } from "../crypto/slot-bytes.js";
import {
  type PrfAndCodeEnvelope,
  type SealedSlot,
  type SlotPlaintext,
  openPrfAndCode,
  openProfileSlot,
  sealPrfAndCode,
  sealProfileSlot,
} from "../crypto/slots.js";
import type { CodeTriggerKind } from "./kinds.js";

export type TriggerSlotScope = Readonly<{
  vaultRef: string;
  deviceBindingRef: string;
  policyRevision: number;
  keyEpoch: number;
}>;

export type SealedTriggerSlot = Readonly<{
  slot: SealedSlot;
  prfEnvelope?: PrfAndCodeEnvelope;
}>;

/** What opening needs to know about an enrolled trigger. */
export type OpenableTrigger = Readonly<{
  slot: SealedSlot;
  triggerKind: CodeTriggerKind;
  prfEnvelope?: PrfAndCodeEnvelope;
}>;

export async function sealTriggerSlot(input: {
  triggerKind: CodeTriggerKind;
  code: string;
  slotId: string;
  profileId: string;
  scope: TriggerSlotScope;
  plaintext: SlotPlaintext;
  prfOutput?: Uint8Array | null;
}): Promise<SealedTriggerSlot> {
  const slot = await sealProfileSlot({
    code: input.code,
    slotId: input.slotId,
    profileId: input.profileId,
    vaultRef: input.scope.vaultRef,
    deviceBindingRef: input.scope.deviceBindingRef,
    policyRevision: input.scope.policyRevision,
    keyEpoch: input.scope.keyEpoch,
    plaintext: input.plaintext,
  });
  if (input.triggerKind !== "prf_and_code") return { slot };
  if (!input.prfOutput || input.prfOutput.length < 32) {
    throw new Error(
      "unsupported_factor: prf_and_code requires the passkey's PRF output at enrollment",
    );
  }
  // The inner layer is the code-sealed slot ciphertext; the outer layer
  // needs the PRF output as well. Nothing code-only is kept.
  const prfEnvelope = await sealPrfAndCode({
    prfOutput: input.prfOutput,
    code: input.code,
    compartmentKey: fromB64(slot.ciphertextB64),
    profileId: input.profileId,
    vaultRef: input.scope.vaultRef,
    policyRevision: input.scope.policyRevision,
    keyEpoch: input.scope.keyEpoch,
  });
  return { slot: { ...slot, ciphertextB64: "" }, prfEnvelope };
}

function envelopeBelongsToSlot(
  envelope: PrfAndCodeEnvelope,
  slot: SealedSlot,
): boolean {
  return (
    envelope.profileId === slot.profileId &&
    envelope.vaultRef === slot.vaultRef &&
    envelope.policyRevision === slot.policyRevision &&
    envelope.keyEpoch === slot.keyEpoch
  );
}

/** Open an enrolled slot; `prf_and_code` needs the PRF output and the code. */
export async function openTriggerSlot(input: {
  enrolled: OpenableTrigger;
  code: string;
  expect: TriggerSlotScope;
  prfOutput?: Uint8Array | null;
}): Promise<SlotPlaintext | null> {
  const { enrolled } = input;
  if (enrolled.triggerKind !== "prf_and_code") {
    return openProfileSlot(input.code, enrolled.slot, input.expect);
  }
  const envelope = enrolled.prfEnvelope;
  // A prf_and_code trigger without its PRF layer is refused, never opened by
  // the code alone.
  if (!envelope || !input.prfOutput || input.prfOutput.length < 32) {
    return null;
  }
  if (!envelopeBelongsToSlot(envelope, enrolled.slot)) return null;
  const inner = await openPrfAndCode({
    prfOutput: input.prfOutput,
    code: input.code,
    envelope,
  });
  if (!inner) return null;
  return openProfileSlot(
    input.code,
    { ...enrolled.slot, ciphertextB64: b64(inner) },
    input.expect,
  );
}

import {
  type BoundaryValue,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import { EventSealError, type EventSealer } from "./event-seal.js";

/** Text columns carry the same authenticated envelope as JSON event columns. */
export function sealSecretText(
  sealer: EventSealer,
  purpose: string,
  scope: string,
  value: string,
): string {
  return JSON.stringify(sealer.seal(purpose, { value }, scope));
}

/** Explicit migration reader for legacy plaintext and column-bound ciphertext. */
export function openLegacySecretText(
  sealer: EventSealer,
  purpose: string,
  scope: string,
  value: string,
): string {
  let parsed: BoundaryValue;
  try {
    parsed = JSON.parse(value);
  } catch {
    if (/"\$sealed"\s*:/.test(value)) throw new EventSealError(purpose);
    return value;
  }
  if (!isJsonObject(parsed) || !("$sealed" in parsed)) return value;
  try {
    if (!sealer.isSealed(parsed)) throw new EventSealError(purpose);
    const opened = sealer.openLegacyForMigration(purpose, parsed, scope);
    if (!isString(opened.value)) throw new EventSealError(purpose);
    return opened.value;
  } catch {
    throw new EventSealError(purpose);
  }
}

/** Runtime reads accept only current customer/record-bound envelopes. */
export function openSecretText(
  sealer: EventSealer,
  purpose: string,
  scope: string,
  value: string,
): string {
  try {
    const parsed: BoundaryValue = JSON.parse(value);
    if (!isJsonObject(parsed)) throw new EventSealError(purpose);
    const opened = sealer.openCurrent(purpose, parsed, scope);
    if (!isString(opened.value)) throw new EventSealError(purpose);
    return opened.value;
  } catch {
    throw new EventSealError(purpose);
  }
}
export function isCurrentSecretText(value: string): boolean {
  try {
    const parsed: BoundaryValue = JSON.parse(value);
    return (
      isJsonObject(parsed) &&
      isString(parsed.$sealed) &&
      parsed.$sealed.startsWith("osev2.")
    );
  } catch {
    return false;
  }
}

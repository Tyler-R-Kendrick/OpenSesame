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

/** Legacy plaintext remains readable until its next write migrates it. */
export function openSecretText(
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
    const opened = sealer.open(purpose, parsed, scope);
    if (!isString(opened.value)) throw new EventSealError(purpose);
    return opened.value;
  } catch {
    throw new EventSealError(purpose);
  }
}

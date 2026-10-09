/** Vault unlock PIN. Duress stays at 12 digits (ADR 0155) and does not follow this. */
export const MAX_PIN_LENGTH = 64;

/** A wrapping digit run long enough to contain a PIN of `MAX_PIN_LENGTH`. */
function digitRun(start: number, step: number): string {
  let digit = start;
  let out = "";
  const need = MAX_PIN_LENGTH + 10;
  while (out.length < need) {
    out += String(digit);
    digit = (digit + step + 10) % 10;
  }
  return out;
}

export const ASCENDING_DIGITS = digitRun(0, 1);
export const DESCENDING_DIGITS = digitRun(9, -1);

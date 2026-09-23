/**
 * Complete-submission code buffer (TRIGGER-B, TRIGGER-F).
 * Leading zeros preserved; partial entry never selects a profile.
 * Cancel clears without evaluating. No reverse-PIN convention.
 */

import {
  DURESS_PIN_MAX,
  DURESS_PIN_MIN,
  assertTriggerCodeLength,
} from "../crypto/slots.js";

export type SubmissionStatus =
  | { kind: "empty" }
  | { kind: "partial"; length: number; min: number; max: number }
  | { kind: "ready"; length: number }
  | { kind: "cancelled" };

/**
 * Digit buffer for unlock/approval ceremonies.
 * Evaluation happens only via submitComplete() — never on each keystroke.
 */
export class CodeSubmissionBuffer {
  #digits = "";
  #cancelled = false;

  get length(): number {
    return this.#digits.length;
  }

  /** Exact digits including leading zeros — never trim or coerce to number. */
  peek(): string {
    return this.#digits;
  }

  status(): SubmissionStatus {
    if (this.#cancelled && this.#digits.length === 0) {
      return { kind: "cancelled" };
    }
    if (this.#digits.length === 0) return { kind: "empty" };
    if (
      this.#digits.length >= DURESS_PIN_MIN &&
      this.#digits.length <= DURESS_PIN_MAX
    ) {
      return { kind: "ready", length: this.#digits.length };
    }
    return {
      kind: "partial",
      length: this.#digits.length,
      min: DURESS_PIN_MIN,
      max: DURESS_PIN_MAX,
    };
  }

  appendDigit(digit: string): void {
    this.#cancelled = false;
    if (!/^[0-9]$/.test(digit)) return;
    if (this.#digits.length >= DURESS_PIN_MAX) return;
    this.#digits += digit;
  }

  backspace(): void {
    this.#cancelled = false;
    this.#digits = this.#digits.slice(0, -1);
  }

  /** Cancel mid-entry: clear without treating as a complete submission. */
  cancel(): void {
    this.#digits = "";
    this.#cancelled = true;
  }

  /**
   * Explicit complete submission. Returns the code string (leading zeros
   * intact) or null when incomplete / invalid. Does not auto-trigger.
   */
  submitComplete(): string | null {
    const code = this.#digits;
    if (code.length === 0) {
      // Empty / post-cancel submit is not a complete attempt.
      return null;
    }
    this.#digits = "";
    this.#cancelled = false;
    try {
      assertTriggerCodeLength(code);
      return code;
    } catch {
      return null;
    }
  }
}

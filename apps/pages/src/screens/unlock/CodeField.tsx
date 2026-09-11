/**
 * The second-step code field: one monospace slot per digit.
 *
 * A single input keeps one Tab stop, native paste and one-time-code
 * autofill; the track behind it only draws the boxes. Entry is constrained
 * to digits, and a full code completes itself — a paste or an autofill is
 * one gesture, not two — while the form's own commit stays available.
 */

import type { ChangeEvent, RefObject } from "react";

/** Every second-step code (authenticator, email, text) is this many digits. */
const CODE_LENGTH = 6;
/** One rendered slot per digit; the input above the track holds the value. */
const CODE_SLOTS: readonly number[] = Object.freeze(
  Array.from({ length: CODE_LENGTH }, (_, slot) => slot),
);

type Props = {
  id: string;
  inputRef: RefObject<HTMLInputElement | null>;
  value: string;
  disabled: boolean;
  onChange: (digits: string) => void;
  onComplete: () => void;
};

export function CodeField({
  id,
  inputRef,
  value,
  disabled,
  onChange,
  onComplete,
}: Props) {
  function change(event: ChangeEvent<HTMLInputElement>) {
    const digits = event.target.value.replace(/\D/g, "").slice(0, CODE_LENGTH);
    onChange(digits);
    // The timeout lets the state land before the form reads it.
    if (digits.length === CODE_LENGTH) window.setTimeout(onComplete, 0);
  }
  return (
    <div className="codefield">
      <div className="codefield__slots" aria-hidden="true">
        {CODE_SLOTS.map((slot) => (
          <span key={slot} />
        ))}
      </div>
      <input
        id={id}
        ref={inputRef}
        type="text"
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9]*"
        value={value}
        disabled={disabled}
        onChange={change}
      />
    </div>
  );
}

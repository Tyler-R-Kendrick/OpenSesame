import type { Ref } from "react";

/**
 * The session bearer, as one field with one id.
 *
 * Shared rather than repeated because the id has to be unique on the page and
 * the label has to be wired to it by `htmlFor`: an input whose only label is a
 * wrapping element is announced inconsistently, and this is the field a screen
 * reader user is most often sent to by a focus move.
 *
 * `type="password"` for shoulder-surfing on a phone, and `autoComplete="off"`
 * because a session bearer is not a password a manager should learn.
 */

export const TOKEN_FIELD_ID = "session-token";

export interface TokenFieldProps {
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
  inputRef?: Ref<HTMLInputElement>;
}

export function TokenField({
  value,
  onChange,
  disabled,
  inputRef,
}: TokenFieldProps) {
  return (
    <div className="field">
      <label htmlFor={TOKEN_FIELD_ID}>Access token</label>
      <input
        id={TOKEN_FIELD_ID}
        ref={inputRef}
        type="password"
        autoComplete="off"
        value={value}
        disabled={disabled === true}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

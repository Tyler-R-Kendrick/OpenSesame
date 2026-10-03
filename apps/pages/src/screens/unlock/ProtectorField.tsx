import type { ProtectorUnlockMethodId } from "@opensesame/app-core/lib/vault/protection/unlock-protector-methods.js";
import { IconEye, IconEyeOff } from "../../components/Icons.js";

/**
 * The key a person types to open the vault from an enrolled protector
 * (ADR 0152): the recovery key saved when it was enrolled, or an age identity.
 * Concealed like a password, never remembered by the browser, never echoed.
 */
export function ProtectorField({
  method,
  value,
  reveal,
  disabled,
  inputRef,
  onValue,
  onReveal,
}: {
  method: Exclude<ProtectorUnlockMethodId, "agePasskey">;
  value: string;
  reveal: boolean;
  disabled: boolean;
  inputRef: (element: HTMLInputElement | null) => void;
  onValue: (value: string) => void;
  onReveal: () => void;
}) {
  const recovery = method === "recovery";
  const label = recovery ? "Recovery key" : "Age key";
  return (
    <div className="field">
      <label htmlFor="unlock-protector">{label}</label>
      <div className="unlock__reveal">
        <input
          id="unlock-protector"
          ref={inputRef}
          className="unlock__key"
          type={reveal ? "text" : "password"}
          name={`unlock-${method}`}
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          value={value}
          disabled={disabled}
          placeholder={recovery ? undefined : "AGE-SECRET-KEY-1…"}
          onChange={(event) => onValue(event.target.value)}
        />
        <button
          type="button"
          className="icon-btn"
          onClick={onReveal}
          aria-label={
            reveal
              ? `Hide ${label.toLowerCase()}`
              : `Show ${label.toLowerCase()}`
          }
        >
          {reveal ? <IconEyeOff size={18} /> : <IconEye size={18} />}
        </button>
      </div>
    </div>
  );
}

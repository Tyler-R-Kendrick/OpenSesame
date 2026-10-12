import type { Ref } from "react";

export const DROP_TTL_OPTIONS = [
  { label: "10 minutes", ms: 600_000 },
  { label: "1 hour", ms: 3_600_000 },
  { label: "1 day", ms: 86_400_000 },
] as const;

/** The label of a TTL the form offers, or empty when the value is not one of them. */
export function dropTtlLabel(ms: number): string {
  return DROP_TTL_OPTIONS.find((option) => option.ms === ms)?.label ?? "";
}

/**
 * How long the share stays open: three choices side by side, the one in force
 * pressed. The chosen one takes `selectedRef`, so a ceremony that opens can
 * hand it the focus.
 */
export function TtlChoices({
  value,
  onChange,
  selectedRef,
  disabled = false,
}: {
  value: number;
  onChange: (ms: number) => void;
  selectedRef?: Ref<HTMLButtonElement>;
  disabled?: boolean;
}) {
  return (
    <div className="share-ttl" role="radiogroup" aria-label="Opens for">
      {DROP_TTL_OPTIONS.map((option) => (
        <button
          key={option.ms}
          ref={option.ms === value ? selectedRef : undefined}
          type="button"
          aria-pressed={option.ms === value}
          className="share-ttl__choice"
          disabled={disabled}
          onClick={() => onChange(option.ms)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** Local mic mark — kept out of Icons.tsx so that ledger does not rise. */
export function MicIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 3.5a3.2 3.2 0 0 0-3.2 3.2v5.6a3.2 3.2 0 0 0 6.4 0V6.7A3.2 3.2 0 0 0 12 3.5Z" />
      <path d="M7.2 12.2a4.8 4.8 0 0 0 9.6 0" />
      <path d="M12 17v3.5" />
    </svg>
  );
}

export function MicButton({
  listening,
  disabled,
  onToggle,
}: {
  listening: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className={`command-bar__mic${listening ? " is-hot" : ""}`}
      aria-label={listening ? "Stop listening" : "Start listening"}
      aria-pressed={listening}
      title={listening ? "Stop listening (m)" : "Push to speak (m)"}
      disabled={disabled}
      onClick={onToggle}
    >
      <MicIcon />
    </button>
  );
}

import { useCallback, useRef, useState, type ReactNode } from "react";
import { IconCheck, IconCopy, IconEye, IconEyeOff } from "./Icons.js";
import { useCopySecret } from "../lib/vault/hooks.js";

export function useCopyFeedback(): {
  copied: string | null;
  failed: string | null;
  copy: (key: string, value: string) => Promise<void>;
} {
  const copySecret = useCopySecret();
  const [copied, setCopied] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const timer = useRef<number | null>(null);

  const copy = useCallback(
    async (key: string, value: string) => {
      const result = await copySecret(value);
      if (timer.current) window.clearTimeout(timer.current);
      if (result === "copied") {
        setFailed(null);
        setCopied(key);
        timer.current = window.setTimeout(() => setCopied(null), 1800);
      } else {
        setCopied(null);
        setFailed(key);
        timer.current = window.setTimeout(() => setFailed(null), 4000);
      }
    },
    [copySecret],
  );

  return { copied, failed, copy };
}

export function FieldRow({
  label,
  children,
  actions,
}: {
  label: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="frow">
      <div className="frow__text">
        <span className="frow__label">{label}</span>
        {children}
      </div>
      {actions ? <div className="frow__actions">{actions}</div> : null}
    </div>
  );
}

export function CopyButton({
  value,
  label,
  fieldKey,
  copied,
  failed,
  onCopy,
}: {
  value: string;
  label: string;
  fieldKey: string;
  copied: string | null;
  failed: string | null;
  onCopy: (key: string, value: string) => Promise<void>;
}) {
  const isCopied = copied === fieldKey;
  const isFailed = failed === fieldKey;
  return (
    <button
      type="button"
      className={`icon-btn${isCopied ? " is-on" : ""}`}
      onClick={() => void onCopy(fieldKey, value)}
      aria-label={isFailed ? `Could not copy ${label}` : `Copy ${label}`}
      title={
        isFailed
          ? "Your browser blocked clipboard access"
          : isCopied
            ? "Copied"
            : `Copy ${label}`
      }
    >
      {isCopied ? <IconCheck size={17} /> : <IconCopy size={17} />}
    </button>
  );
}

/** A value the vault will not show until asked. */
export function ConcealedValue({
  value,
  label,
  revealed,
}: {
  value: string;
  label: string;
  revealed: boolean;
}) {
  return (
    <>
      <span className={revealed ? "frow__value frow__value--mono" : "conceal"}>
        {revealed ? value : "••••••••••••"}
      </span>
      <span className="visually-hidden" aria-live="polite">
        {revealed ? `${label} is visible` : `${label} is hidden`}
      </span>
    </>
  );
}

export function RevealButton({
  revealed,
  label,
  onToggle,
}: {
  revealed: boolean;
  label: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className={`icon-btn${revealed ? " is-on" : ""}`}
      onClick={onToggle}
      aria-label={revealed ? `Hide ${label}` : `Reveal ${label}`}
      title={revealed ? `Hide ${label}` : `Reveal ${label}`}
    >
      {revealed ? <IconEyeOff size={17} /> : <IconEye size={17} />}
    </button>
  );
}

import { IconCheck } from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";

/** The raw editor's status line and write key. */

export function Status({
  source,
  dirty,
  problem,
  refusal,
  message,
}: {
  source: string;
  dirty: boolean;
  problem: string | null;
  refusal: string | null;
  message: string;
}) {
  const failed = problem ?? refusal;
  const lines = source.split("\n").length - (source.endsWith("\n") ? 1 : 0);
  return (
    <output className="set-raw__status" aria-live="polite">
      {failed === null ? null : <StatusMark tone="err" label={failed} />}
      <span className="set-raw__status-text">
        {problem ??
          (refusal === null ? message || (dirty ? "modified" : "") : "")}
      </span>
      <span className="set-raw__status-meta">
        {dirty ? "[+] " : ""}
        {lines}L
      </span>
    </output>
  );
}

export function WriteButton({
  path,
  disabled,
  onWrite,
}: {
  path: string;
  disabled: boolean;
  onWrite: () => void;
}) {
  return (
    <button
      type="button"
      className="icon-btn icon-btn--sm"
      aria-label={`Write ${path}`}
      title={`Write ${path} (Ctrl-S)`}
      disabled={disabled}
      onClick={onWrite}
    >
      <IconCheck size={14} />
    </button>
  );
}

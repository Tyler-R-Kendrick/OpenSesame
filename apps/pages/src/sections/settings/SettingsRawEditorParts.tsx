import { valueClass } from "@opensesame/app-core/sections/settings/settings-raw-editor-model.js";
import { IconCheck } from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";

/** The raw editor's status line, write key and painted source. */

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

export function paint(source: string) {
  return source.split("\n").map((line, index) => (
    <span key={`${index}-${line}`}>
      {paintLine(line)}
      {"\n"}
    </span>
  ));
}

function paintLine(line: string) {
  if (line.trimStart().startsWith("#"))
    return <span className="set-raw__comment">{line}</span>;
  const at = line.indexOf(":");
  if (at < 0) return <span>{line}</span>;
  const rest = line.slice(at + 1);
  const hash = rest.search(/\s#/);
  const value = hash < 0 ? rest : rest.slice(0, hash);
  const comment = hash < 0 ? "" : rest.slice(hash);
  return (
    <>
      <span className="set-raw__key">{line.slice(0, at)}</span>:
      <span className={valueClass(value)}>{value}</span>
      {comment ? <span className="set-raw__comment">{comment}</span> : null}
    </>
  );
}

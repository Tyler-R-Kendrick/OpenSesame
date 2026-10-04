import type { ConfigDiagnostic } from "@opensesame/app-core/lib/configuration/types.js";
import { StatusMark } from "../StatusMark.js";

/**
 * The draft's own validity is state, not a failure: the field wears a mark and
 * `aria-invalid`, and nothing is raised in the tray (ADR 0163).
 */
export function SourceEditor(props: {
  id: string;
  value: string;
  diagnostics: readonly ConfigDiagnostic[];
  onChange: (value: string) => void;
  onSave?: () => void;
  disabled?: boolean;
}) {
  const error = props.diagnostics.find((item) => item.severity === "error");
  return (
    <div className="cfg-source">
      <label className="cfg-source__label" htmlFor={props.id}>
        Source
      </label>
      <textarea
        id={props.id}
        data-config-source="true"
        className="cfg-source__input"
        spellCheck={false}
        value={props.value}
        disabled={props.disabled}
        aria-invalid={error ? true : undefined}
        onChange={(event) => props.onChange(event.target.value)}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === "s") {
            event.preventDefault();
            props.onSave?.();
          }
        }}
      />
      {error ? <StatusMark tone="err" label={error.message} /> : null}
    </div>
  );
}

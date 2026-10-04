import type { ConfigDiagnostic } from "@opensesame/app-core/lib/configuration/types.js";
import { FailureNotice } from "../FailureNotice.js";

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
      <FailureNotice
        id={`config-source:${props.id}`}
        title="Configuration"
        message={error?.message}
      />
    </div>
  );
}

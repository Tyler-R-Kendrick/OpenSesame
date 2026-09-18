import type { ConfigDiagnostic } from "../../lib/configuration/types.js";

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
        aria-describedby={error ? `${props.id}-err` : undefined}
        onChange={(event) => props.onChange(event.target.value)}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === "s") {
            event.preventDefault();
            props.onSave?.();
          }
        }}
      />
      {error ? (
        <p id={`${props.id}-err`} className="cfg-source__err" role="alert">
          {error.message}
        </p>
      ) : null}
    </div>
  );
}

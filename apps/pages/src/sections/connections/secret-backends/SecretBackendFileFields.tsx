import { useId } from "react";
import { FieldShell } from "../../../components/FieldShell.js";
import type { SecretBackendFieldProps } from "./secret-backend-fields.js";

type Props = SecretBackendFieldProps & {
  formats: readonly { id: string; label: string }[];
  file: File | null;
  password: string;
  onFile: (file: File | null) => void;
  onPassword: (value: string) => void;
};

export function SecretBackendFileFields(props: Props) {
  const id = useId();
  return (
    <>
      <div className="field">
        <label htmlFor={`${id}-format`}>Export format</label>
        <select
          id={`${id}-format`}
          value={props.draft.fileFormat}
          disabled={props.busy}
          onChange={(event) => props.onChange("fileFormat", event.target.value)}
        >
          {props.formats.map((format) => (
            <option key={format.id} value={format.id}>
              {format.label}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor={`${id}-file`}>Export file</label>
        <input
          key={props.file?.name ?? "empty"}
          id={`${id}-file`}
          type="file"
          disabled={props.busy}
          onChange={(event) => props.onFile(event.target.files?.[0] ?? null)}
        />
      </div>
      {props.file ? (
        <FieldShell label="Selected file" value={props.file.name} readOnly />
      ) : null}
      <details className="conn-client-alt">
        <summary>Encrypted export</summary>
        <FieldShell
          label="Export password"
          value={props.password}
          type="password"
          autoComplete="new-password"
          disabled={props.busy}
          onValueChange={props.onPassword}
        />
      </details>
    </>
  );
}

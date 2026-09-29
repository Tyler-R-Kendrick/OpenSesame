import type {
  ConfigurationField,
  Provider,
} from "@opensesame/app-core/lib/connections.js";
import { fieldGuidance } from "@opensesame/app-core/lib/connector-guidance.js";
import { type FormEvent, useId } from "react";
import { FormCommit } from "../../components/FormCommit.js";
import { IconInfo } from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";
import { defaultsFor } from "./connect-defaults.js";

function FieldRows({
  fields,
  idPrefix,
  defaults,
  values,
  onChange,
}: {
  fields: ConfigurationField[];
  idPrefix: string;
  defaults: Record<string, string>;
  values: Record<string, string>;
  onChange: (name: string, value: string) => void;
}) {
  return fields.map((field) => {
    const id = `${idPrefix}-${field.name}`;
    const guidance = fieldGuidance(field);
    const automatic = defaults[field.name];
    return (
      <div className="field" key={field.name}>
        <label className="label conn-field-label" htmlFor={id}>
          {field.label}
          {automatic
            ? " (automatic)"
            : field.required
              ? " (required)"
              : " (optional)"}
          <span title={guidance.help} aria-hidden="true">
            <IconInfo size={14} />
          </span>
        </label>
        <input
          id={id}
          name={field.name}
          type={
            field.secret
              ? "password"
              : field.name.endsWith("_url")
                ? "url"
                : "text"
          }
          autoComplete="off"
          required={field.required}
          placeholder={guidance.placeholder}
          aria-describedby={`${id}-help`}
          title={guidance.help}
          value={values[field.name] ?? ""}
          onChange={(event) => onChange(field.name, event.target.value)}
        />
        <p className="hint" id={`${id}-help`}>
          {guidance.help}
          {automatic ? " Filled automatically; change it if needed." : ""}
        </p>
      </div>
    );
  });
}

/**
 * A `configuration` connector's fields: what the provider needs first, then
 * the optional ones behind one disclosure. Controlled by its caller, so a
 * failed save leaves every value where the person typed it.
 */
export function ConfigurationForm({
  provider,
  name,
  values,
  busy,
  online,
  failure,
  onName,
  onValue,
  onSubmit,
}: {
  provider: Provider;
  name: string;
  values: Record<string, string>;
  busy: boolean;
  online: boolean;
  /** The sentence for the last try that failed, drawn beside the key. */
  failure: string;
  onName: (value: string) => void;
  onValue: (name: string, value: string) => void;
  onSubmit: (event: FormEvent) => void;
}) {
  const nameId = useId();
  const defaults = defaultsFor(provider);
  const fields = provider.configurationFields ?? [];
  const required = fields.filter(
    (field) => field.required && defaults[field.name] === undefined,
  );
  const optional = fields.filter((field) => !required.includes(field));
  const rows = (list: ConfigurationField[]) => (
    <FieldRows
      fields={list}
      idPrefix={nameId}
      defaults={defaults}
      values={values}
      onChange={onValue}
    />
  );
  return (
    <form className="conn-tile__body" onSubmit={onSubmit}>
      {rows(required)}
      <details className="conn-client-alt">
        <summary>Optional settings</summary>
        <div className="field">
          <label className="label" htmlFor={nameId}>
            Name it (optional)
          </label>
          <input
            id={nameId}
            value={name}
            onChange={(event) => onName(event.target.value)}
          />
          <p className="hint">
            Only changes the label in OpenSesame; the provider never sees it.
          </p>
        </div>
        {rows(optional)}
      </details>
      <p className="hint">
        Secret fields are sealed on arrival and are never returned to this
        browser.
      </p>
      <FormCommit
        label={busy ? "Saving" : "Save configuration"}
        busy={busy}
        disabled={busy || !online}
      >
        {failure ? <StatusMark tone="err" label={failure} /> : null}
      </FormCommit>
    </form>
  );
}

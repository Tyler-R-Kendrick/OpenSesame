import { useId } from "react";
import { FieldShell } from "../../../components/FieldShell.js";
import { StatusMark } from "../../../components/StatusMark.js";
import { ConfigSelections } from "./ConfigSelections.js";
import {
  NativeProviderInstructions,
  nativeProviderInstructionText,
} from "./NativeProviderInstructions.js";
import { OutLink, SelectField } from "./fields.js";
import {
  nativePublicUrl,
  nativeVisibleFields,
} from "./native-connector-ui-values.js";
import type {
  NativeField,
  NativeMethodDescriptor,
} from "./native-connector-ui.js";

function methodLinks(links: NativeMethodDescriptor["links"]) {
  const unique = new Map<string, { label: string; url: string }>();
  for (const link of links ?? []) {
    const url = nativePublicUrl(link.url);
    if (url)
      unique.set(JSON.stringify([link.label, url]), { label: link.label, url });
  }
  return [...unique].map(([id, link]) => ({ id, ...link }));
}

function NativeFieldControl({
  field,
  value,
  onChange,
}: {
  field: NativeField;
  value: string;
  onChange: (value: string) => void;
}) {
  const id = useId();
  if (field.kind === "choice" && !field.secret)
    return (
      <SelectField
        label={field.label}
        value={value}
        options={[{ id: "", label: "Select…" }, ...(field.choices ?? [])]}
        onChange={onChange}
      />
    );
  if (field.kind === "textarea" && !field.secret)
    return (
      <div className="cx-select">
        <label className="f__label" htmlFor={id}>
          {field.label}
        </label>
        <textarea
          id={id}
          className="cx-textarea"
          value={value}
          maxLength={field.maxLength ?? 100_000}
          readOnly={field.readOnly}
          onChange={(event) => onChange(event.target.value)}
        />
      </div>
    );
  return (
    <FieldShell
      label={field.label}
      value={value}
      type={field.secret ? "password" : field.kind === "url" ? "url" : "text"}
      placeholder={field.placeholder}
      autoComplete={field.secret ? "new-password" : "off"}
      readOnly={field.readOnly}
      mono={field.secret || field.kind === "url"}
      onValueChange={onChange}
    />
  );
}

export function NativeInputFields({
  fields,
  values,
  onChange,
}: {
  fields: readonly NativeField[];
  values: Record<string, string>;
  onChange: (id: string, value: string) => void;
}) {
  return nativeVisibleFields(fields, values).map((field) => (
    <div className="cx-form" key={field.id}>
      <NativeFieldControl
        field={field}
        value={values[field.id] ?? ""}
        onChange={(value) => onChange(field.id, value)}
      />
      {field.help ? (
        <StatusMark
          tone="idle"
          label={nativeProviderInstructionText(field.help)}
        />
      ) : null}
    </div>
  ));
}

export function NativeConnectorFields({
  method,
  values,
  scopes,
  onValue,
  onScopes,
}: {
  method: NativeMethodDescriptor;
  values: Record<string, string>;
  scopes: Record<string, string[]>;
  onValue: (id: string, value: string) => void;
  onScopes: (actor: string, selected: string[]) => void;
}) {
  const links = methodLinks(method.links);
  const instructionOrigins = links.map((link) => new URL(link.url).origin);
  const fields = method.fields.filter(
    (field) => (field.required || field.secret) && !field.displayOnly,
  );
  const options = method.fields.filter(
    (field) => (!field.required && !field.secret) || field.displayOnly,
  );
  return (
    <>
      <NativeInputFields fields={fields} values={values} onChange={onValue} />
      {options.length || method.scopeGroups.length ? (
        <details className="cx-application">
          <summary>Sign-in options</summary>
          <NativeInputFields
            fields={options}
            values={values}
            onChange={onValue}
          />
          {method.scopeGroups.map((group) => (
            <div className="cx-form" key={group.actor} title={group.help}>
              <ConfigSelections
                label={group.label}
                choices={group.choices}
                selected={scopes[group.actor] ?? []}
                requiredChoices={group.requiredScopes}
                onChange={(selected) => onScopes(group.actor, selected)}
              />
            </div>
          ))}
        </details>
      ) : null}
      {method.instructions ? (
        <details className="cx-application">
          <summary>Sign-in help</summary>
          <NativeProviderInstructions
            text={method.instructions}
            origins={instructionOrigins}
          />
        </details>
      ) : null}
      <div className="cx-links">
        {links.map((link) => (
          <OutLink key={link.id} href={link.url}>
            {link.label}
          </OutLink>
        ))}
      </div>
    </>
  );
}

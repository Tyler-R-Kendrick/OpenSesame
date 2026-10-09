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
      <label className="cx-select" htmlFor={id}>
        <span className="f__label">{field.label}</span>
        <textarea
          id={id}
          className="cx-textarea"
          value={value}
          maxLength={100_000}
          readOnly={field.readOnly}
          onChange={(event) => onChange(event.target.value)}
        />
      </label>
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
  const instructionOrigins = (method.links ?? []).flatMap((link) => {
    const url = nativePublicUrl(link.url);
    return url ? [new URL(url).origin] : [];
  });
  return (
    <>
      {method.instructions ? (
        <details className="cx-application">
          <summary>Provider setup guide</summary>
          <NativeProviderInstructions
            text={method.instructions}
            origins={instructionOrigins}
          />
        </details>
      ) : null}
      <NativeInputFields
        fields={method.fields}
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
      <div className="cx-links">
        {method.links?.map((link) => {
          const url = nativePublicUrl(link.url);
          return url ? (
            <OutLink key={link.label} href={url}>
              {link.label}
            </OutLink>
          ) : null;
        })}
      </div>
    </>
  );
}

import { isString } from "@opensesame/os-domain";
import {
  FIELD_TYPES,
  type FieldDefinition,
  type FieldTypeId,
  type FieldValue,
} from "@opensesame/vault-item-types";
import { RevealButton } from "../../components/FieldRow.js";
import { IconPlus, IconX } from "../../components/Icons.js";

/**
 * The HTML input type a catalogue entry asks for.
 *
 * A switch rather than a lookup table: the catalogue is closed, so the
 * exhaustive arm is free, and there is no key this can be asked for that it
 * has not already answered.
 */
function htmlInputType(id: FieldTypeId): string {
  switch (id) {
    case "email":
      return "email";
    case "url":
      return "url";
    case "number":
      return "number";
    case "date":
      return "date";
    case "month-year":
      return "month";
    case "phone":
      return "tel";
    default:
      return "text";
  }
}

function inputType(field: FieldDefinition, revealed: boolean): string {
  if (FIELD_TYPES[field.type].concealed) return revealed ? "text" : "password";
  return htmlInputType(field.type);
}

export function asText(value: FieldValue | undefined): string {
  return isString(value) ? value : "";
}

export function asList(value: FieldValue | undefined): string[] {
  if (Array.isArray(value)) return value.filter(isString);
  return isString(value) && value !== "" ? [value] : [];
}

export function asParts(value: FieldValue | undefined): Record<string, string> {
  if (value === undefined || isString(value) || Array.isArray(value)) return {};
  return value;
}

export function Hint({ field }: { field: FieldDefinition }) {
  return field.help === undefined ? null : <p className="hint">{field.help}</p>;
}

export function ScalarInput({
  field,
  value,
  revealed,
  onToggle,
  onChange,
}: {
  field: FieldDefinition;
  value: string;
  revealed: boolean;
  onToggle: () => void;
  onChange: (next: string) => void;
}) {
  const spec = FIELD_TYPES[field.type];
  if (spec.multiline) {
    return (
      <textarea
        id={field.id}
        rows={4}
        spellCheck={false}
        value={value}
        placeholder={field.placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  }
  if (field.type === "select") {
    return (
      <select
        id={field.id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">—</option>
        {(field.options ?? []).map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    );
  }
  if (field.type === "boolean") {
    return (
      <input
        id={field.id}
        type="checkbox"
        checked={value === "true"}
        onChange={(event) => onChange(event.target.checked ? "true" : "")}
      />
    );
  }
  const input = (
    <input
      id={field.id}
      type={inputType(field, revealed)}
      autoComplete="off"
      spellCheck={false}
      value={value}
      placeholder={field.placeholder}
      onChange={(event) => onChange(event.target.value)}
    />
  );
  if (!spec.concealed) return input;
  return (
    <div className="editor__inline">
      {input}
      <RevealButton
        revealed={revealed}
        label={field.label.toLowerCase()}
        onToggle={onToggle}
      />
    </div>
  );
}

export function RepeatingInput({
  field,
  values,
  onChange,
}: {
  field: FieldDefinition;
  values: string[];
  onChange: (next: string[]) => void;
}) {
  return (
    <>
      {values.map((entry, index) => (
        <div
          className="editor__inline"
          // A repeated row has no identity of its own: the definition format
          // deliberately has no field for one, so position is what there is.
          key={`${field.id}-${index}`}
        >
          <input
            aria-label={`${field.label} ${index + 1}`}
            autoComplete="off"
            spellCheck={false}
            value={entry}
            onChange={(event) =>
              onChange(
                values.map((current, position) =>
                  position === index ? event.target.value : current,
                ),
              )
            }
          />
          <button
            type="button"
            className="icon-btn"
            aria-label={`Remove ${field.label} ${index + 1}`}
            title="Remove"
            onClick={() =>
              onChange(values.filter((_, position) => position !== index))
            }
          >
            <IconX size={15} />
          </button>
        </div>
      ))}
      <button
        type="button"
        className="icon-btn icon-btn--sm"
        aria-label={`Add ${field.label.toLowerCase()}`}
        title={`Add ${field.label.toLowerCase()}`}
        onClick={() => onChange([...values, ""])}
      >
        <IconPlus size={15} />
      </button>
    </>
  );
}

export function RecordInput({
  field,
  parts,
  revealedParts,
  onToggle,
  onChange,
}: {
  field: FieldDefinition;
  parts: Record<string, string>;
  revealedParts: ReadonlySet<string>;
  onToggle: (partKey: string) => void;
  onChange: (next: Record<string, string>) => void;
}) {
  return (
    <div className="editor__grid">
      {FIELD_TYPES[field.type].parts.map((part) => {
        const key = `${field.id}.${part.id}`;
        const revealed = revealedParts.has(key);
        return (
          <div className="field" key={key}>
            <label htmlFor={key}>{part.label}</label>
            {part.concealed ? (
              <div className="editor__inline">
                <input
                  id={key}
                  type={revealed ? "text" : "password"}
                  autoComplete="off"
                  value={parts[part.id] ?? ""}
                  onChange={(event) =>
                    onChange({ ...parts, [part.id]: event.target.value })
                  }
                />
                <RevealButton
                  revealed={revealed}
                  label={part.label.toLowerCase()}
                  onToggle={() => onToggle(key)}
                />
              </div>
            ) : (
              <input
                id={key}
                autoComplete="off"
                value={parts[part.id] ?? ""}
                onChange={(event) =>
                  onChange({ ...parts, [part.id]: event.target.value })
                }
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * The generic ceremony (ADR 0087 §1).
 *
 * One editor and one detail renderer for every item type there will ever be.
 * They read the definition — sections, field types from the closed catalogue,
 * labels, required-ness — and draw it. There is no per-type code here and no
 * place to put any: a definition names behaviours, it does not describe them.
 *
 * Concealment is a property of the field type, so a plugin author cannot make
 * a secret render in the clear, and a value that is concealed here is
 * concealed in the item list and the search index too.
 */

import { isString } from "@opensesame/os-domain";
import {
  FIELD_TYPES,
  type FieldDefinition,
  type FieldTypeId,
  type FieldValue,
  type FieldValues,
  type ItemTypeDefinition,
  displayText,
} from "@opensesame/vault-item-types";
import { useState } from "react";
import {
  ConcealedValue,
  CopyButton,
  FieldRow,
  RevealButton,
} from "../../components/FieldRow.js";
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

function asText(value: FieldValue | undefined): string {
  return isString(value) ? value : "";
}

function asList(value: FieldValue | undefined): string[] {
  if (Array.isArray(value)) return value.filter(isString);
  return isString(value) && value !== "" ? [value] : [];
}

function asParts(value: FieldValue | undefined): Record<string, string> {
  if (value === undefined || isString(value) || Array.isArray(value)) return {};
  return value;
}

type ChangeField = (fieldId: string, value: FieldValue) => void;

function Hint({ field }: { field: FieldDefinition }) {
  return field.help === undefined ? null : <p className="hint">{field.help}</p>;
}

function ScalarInput({
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

function RepeatingInput({
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

function RecordInput({
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

/** The editor for every plugin-defined type, drawn from its definition. */
export function TypedFieldInputs({
  definition,
  values,
  onChange,
}: {
  definition: ItemTypeDefinition;
  values: FieldValues;
  onChange: ChangeField;
}) {
  const [revealed, setRevealed] = useState<ReadonlySet<string>>(new Set());
  const toggle = (key: string) =>
    setRevealed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <>
      {definition.spec.sections.map((section) => (
        <div className="editor__grid" key={section.id}>
          <span className="label editor__grouplabel">{section.title}</span>
          {section.fields.map((field) => {
            const spec = FIELD_TYPES[field.type];
            const value = values[field.id];
            return (
              <div className="field" key={field.id}>
                <label htmlFor={field.id}>
                  {field.label}
                  {field.required === true ? " *" : ""}
                </label>
                {spec.valueKind === "record" ? (
                  <RecordInput
                    field={field}
                    parts={asParts(value)}
                    revealedParts={revealed}
                    onToggle={toggle}
                    onChange={(next) => onChange(field.id, next)}
                  />
                ) : field.multiple === true ? (
                  <RepeatingInput
                    field={field}
                    values={asList(value)}
                    onChange={(next) => onChange(field.id, next)}
                  />
                ) : (
                  <ScalarInput
                    field={field}
                    value={asText(value)}
                    revealed={revealed.has(field.id)}
                    onToggle={() => toggle(field.id)}
                    onChange={(next) => onChange(field.id, next)}
                  />
                )}
                <Hint field={field} />
              </div>
            );
          })}
        </div>
      ))}
    </>
  );
}

type RowProps = {
  field: FieldDefinition;
  text: string;
  revealed: ReadonlySet<string>;
  toggle: (key: string) => void;
  copied: string | null;
  failed: string | null;
  copy: (key: string, value: string) => Promise<void>;
};

function ValueRow({
  field,
  text,
  revealed,
  toggle,
  copied,
  failed,
  copy,
}: RowProps) {
  const spec = FIELD_TYPES[field.type];
  const label = field.label.toLowerCase();
  if (!spec.concealed) {
    return (
      <FieldRow
        label={field.label}
        actions={
          <CopyButton
            value={text}
            label={label}
            fieldKey={field.id}
            copied={copied}
            failed={failed}
            onCopy={copy}
          />
        }
      >
        <span
          className={`frow__value${spec.multiline ? " frow__value--wrap" : ""}`}
        >
          {text}
        </span>
      </FieldRow>
    );
  }
  return (
    <FieldRow
      label={field.label}
      actions={
        <>
          <RevealButton
            revealed={revealed.has(field.id)}
            label={label}
            onToggle={() => toggle(field.id)}
          />
          <CopyButton
            value={text}
            label={label}
            fieldKey={field.id}
            copied={copied}
            failed={failed}
            onCopy={copy}
          />
        </>
      }
    >
      <ConcealedValue
        value={text}
        label={label}
        revealed={revealed.has(field.id)}
      />
    </FieldRow>
  );
}

/** The detail view for every plugin-defined type, drawn from its definition. */
export function TypedFieldRows({
  definition,
  values,
  revealed,
  toggle,
  copied,
  failed,
  copy,
}: {
  definition: ItemTypeDefinition;
  values: FieldValues;
  revealed: ReadonlySet<string>;
  toggle: (key: string) => void;
  copied: string | null;
  failed: string | null;
  copy: (key: string, value: string) => Promise<void>;
}) {
  return (
    <>
      {definition.spec.sections.map((section) => {
        const rows = section.fields
          .map((field) => ({
            field,
            text: displayText(field, values[field.id]),
          }))
          .filter((row) => row.text !== "");
        if (rows.length === 0) return null;
        return (
          <section className="detail__group" key={section.id}>
            <h2 className="detail__grouphead">{section.title}</h2>
            {rows.map((row) => (
              <ValueRow
                key={row.field.id}
                field={row.field}
                text={row.text}
                revealed={revealed}
                toggle={toggle}
                copied={copied}
                failed={failed}
                copy={copy}
              />
            ))}
          </section>
        );
      })}
    </>
  );
}

/**
 * What an item whose type is not installed here shows.
 *
 * Its values are intact and are named as they are stored — the definition may
 * arrive on the next sync, and until it does the honest thing is to say so
 * rather than to guess at labels or, worse, coerce the item into a note.
 *
 * Every value is concealed, because without the definition there is no way to
 * know which of them were. Erring the other way would put a bank account
 * number in the clear the first time a definition failed to sync.
 */
export function UnknownTypeRows({
  typeId,
  values,
  revealed,
  toggle,
}: {
  typeId: string;
  values: FieldValues;
  revealed: ReadonlySet<string>;
  toggle: (key: string) => void;
}) {
  const entries = Object.entries(values).filter(
    ([, value]) => value !== undefined,
  );
  return (
    <section className="detail__group">
      <h2 className="detail__grouphead">Stored fields</h2>
      <p className="hint">
        The definition for <code>{typeId}</code> is not installed on this
        device. Nothing has been lost — every value is here, concealed because
        this device cannot tell which of them the type meant to hide. Install
        the definition and the record renders in full.
      </p>
      {entries.map(([id, value]) => {
        const text = isString(value) ? value : JSON.stringify(value);
        return (
          <FieldRow
            label={id}
            key={id}
            actions={
              <RevealButton
                revealed={revealed.has(id)}
                label={id}
                onToggle={() => toggle(id)}
              />
            }
          >
            <ConcealedValue
              value={text}
              label={id}
              revealed={revealed.has(id)}
            />
          </FieldRow>
        );
      })}
    </section>
  );
}

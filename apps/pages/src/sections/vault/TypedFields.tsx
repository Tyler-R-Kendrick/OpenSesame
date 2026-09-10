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
import { OptionalField } from "./EditorExtras.js";
import {
  Hint,
  RecordInput,
  RepeatingInput,
  ScalarInput,
  asList,
  asParts,
  asText,
} from "./TypedFieldInputs.js";
type ChangeField = (fieldId: string, value: FieldValue) => void;

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
              <OptionalField
                key={field.id}
                present={
                  field.required === true || displayText(field, value) !== ""
                }
                command={`Add ${field.label.toLowerCase()}`}
                onAdd={
                  field.multiple === true && asList(value).length === 0
                    ? () => onChange(field.id, [""])
                    : undefined
                }
              >
                <div className="field">
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
              </OptionalField>
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

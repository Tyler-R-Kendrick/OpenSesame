import { type ReactNode, useEffect, useRef, useState } from "react";
import {
  IconEye,
  IconEyeOff,
  IconPlus,
  IconX,
} from "../../components/Icons.js";
import {
  type CustomField,
  type VaultItem,
  newId,
} from "../../lib/vault/model.js";

export function OptionalField({
  present,
  command,
  onAdd,
  children,
}: {
  present: boolean;
  command: string;
  onAdd?: () => void;
  children: ReactNode;
}) {
  const initiallyPresent = useRef(present);
  const [added, setAdded] = useState(false);
  const field = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (added)
      field.current
        ?.querySelector<HTMLElement>("input, textarea, select")
        ?.focus();
  }, [added]);
  if (!initiallyPresent.current && !present && !added)
    return (
      <button
        type="button"
        className="btn btn--sm editor__optional"
        onClick={() => {
          onAdd?.();
          setAdded(true);
        }}
      >
        <IconPlus size={15} />
        {command}
      </button>
    );
  return <div ref={field}>{children}</div>;
}

/** Group heading with its one action beside it: a label and a + key. */
export function GroupAdd({
  label,
  action,
  onAdd,
}: {
  label: string;
  action: string;
  onAdd: () => void;
}) {
  return (
    <span className="label editor__grouplabel">
      {label}
      <button
        type="button"
        className="icon-btn icon-btn--sm"
        aria-label={action}
        title={action}
        onClick={onAdd}
      >
        <IconPlus size={15} />
      </button>
    </span>
  );
}

function CustomFields({
  draft,
  onChange: patch,
}: { draft: VaultItem; onChange: (changes: Partial<VaultItem>) => void }) {
  function setField(id: string, changes: Partial<CustomField>) {
    patch({
      fields: draft.fields.map((field) =>
        field.id === id ? { ...field, ...changes } : field,
      ),
    });
  }
  function addField() {
    patch({
      fields: [
        ...draft.fields,
        { id: newId(), name: "", value: "", hidden: false },
      ],
    });
  }
  return (
    <OptionalField
      present={draft.fields.length > 0}
      command="Add custom field"
      onAdd={addField}
    >
      <div className="field">
        <GroupAdd label="Custom fields" action="Add field" onAdd={addField} />
        {draft.fields.map((field) => (
          <div className="editor__uri" key={field.id}>
            <input
              value={field.name}
              placeholder="Field name"
              aria-label="Field name"
              onChange={(event) =>
                setField(field.id, { name: event.target.value })
              }
            />
            <input
              type={field.hidden ? "password" : "text"}
              value={field.value}
              placeholder="Value"
              aria-label="Field value"
              onChange={(event) =>
                setField(field.id, { value: event.target.value })
              }
            />
            <div className="editor__inline">
              <button
                type="button"
                className={`icon-btn${field.hidden ? " is-on" : ""}`}
                aria-pressed={field.hidden}
                aria-label="Conceal this field"
                title="Conceal this field"
                onClick={() => setField(field.id, { hidden: !field.hidden })}
              >
                {field.hidden ? (
                  <IconEyeOff size={17} />
                ) : (
                  <IconEye size={17} />
                )}
              </button>
              <button
                type="button"
                className="icon-btn"
                aria-label={`Remove ${field.name || "field"}`}
                onClick={() =>
                  patch({
                    fields: draft.fields.filter(
                      (candidate) => candidate.id !== field.id,
                    ),
                  })
                }
              >
                <IconX size={17} />
              </button>
            </div>
          </div>
        ))}
      </div>
    </OptionalField>
  );
}

export function EditorExtras({
  draft,
  onChange: patch,
}: { draft: VaultItem; onChange: (changes: Partial<VaultItem>) => void }) {
  return (
    <>
      <OptionalField
        present={draft.kind === "note" || Boolean(draft.notes)}
        command="Add notes"
      >
        <div className="field">
          <label htmlFor="notes">Notes</label>
          <textarea
            id="notes"
            value={draft.notes}
            rows={draft.kind === "note" ? 12 : 4}
            onChange={(event) => patch({ notes: event.target.value })}
          />
        </div>
      </OptionalField>

      <CustomFields draft={draft} onChange={patch} />

      <OptionalField
        present={draft.favorite}
        command="Pin item"
        onAdd={() => patch({ favorite: true })}
      >
        <div className="editor__row">
          <div className="field">
            <label className="check">
              <input
                type="checkbox"
                checked={draft.favorite}
                onChange={(event) => patch({ favorite: event.target.checked })}
              />
              <span>Pin to the top of the list</span>
            </label>
          </div>
        </div>
      </OptionalField>
    </>
  );
}

/**
 * What a joined live session shows (ADR 0150 §5): the shared items, their
 * open fields as the owner sent them, and each concealed field as a key that
 * asks the owner for it. A value the owner answers is held in this
 * component's state only, and goes when the person hides it, leaves, or the
 * session ends. An `edit` session can also ask the owner to replace a shared
 * field in the open vault.
 *
 * `use` (Copy only) does not draw a reveal key and does not place the
 * concealed plaintext on this clipboard. The owner refuses both `reveal`
 * and `copy`, so the value never arrives to be written.
 */

import type {
  Catalog,
  SharedField,
  SharedItem,
} from "@opensesame/app-core/lib/live/messages.js";
import { useState } from "react";
import {
  ConcealedValue,
  RevealButton,
  useCopyFeedback,
} from "../../components/FieldRow.js";
import { IconCheck, IconCopy } from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";
import { EditableRow } from "./LiveFieldEdit.js";

export type RequestField = (
  what: "reveal" | "copy",
  item: string,
  field: string,
) => Promise<string | null>;

export type SaveField = (
  item: string,
  field: string,
  value: string,
) => Promise<string | null>;

function ConcealedField({
  item,
  field,
  canReveal,
  canCopy,
  canEdit,
  request,
  save,
}: {
  item: SharedItem;
  field: SharedField;
  canReveal: boolean;
  /** False for Copy only: the secret must not be written to this clipboard. */
  canCopy: boolean;
  canEdit: boolean;
  request: RequestField;
  save?: SaveField;
}) {
  const [shown, setShown] = useState<string | null>(null);
  const [denied, setDenied] = useState(false);
  const { copied, failed, copy } = useCopyFeedback();
  const key = `${item.id}:${field.key}`;
  const label = `${item.name} ${field.label}`;

  async function toggle(): Promise<void> {
    if (shown !== null) {
      setShown(null);
      return;
    }
    const value = await request("reveal", item.id, field.key);
    setDenied(value === null);
    setShown(value);
  }

  async function copyIt(): Promise<void> {
    // Copy only never asks for the plaintext and never writes it here.
    if (!canCopy) return;
    const value = await request("copy", item.id, field.key);
    setDenied(value === null);
    if (value !== null) await copy(key, value);
  }

  return (
    <EditableRow
      fieldLabel={field.label}
      editLabel={label}
      canEdit={canEdit}
      save={save ? (value) => save(item.id, field.key, value) : undefined}
      onSaved={(value) => {
        setDenied(false);
        setShown(value);
      }}
      actions={
        canReveal || canCopy ? (
          <>
            {canReveal ? (
              <RevealButton
                revealed={shown !== null}
                label={label}
                onToggle={() => void toggle()}
              />
            ) : null}
            {canCopy ? (
              <button
                type="button"
                className={`icon-btn${copied === key ? " is-on" : ""}`}
                aria-label={
                  failed === key ? `Could not copy ${label}` : `Copy ${label}`
                }
                title={
                  failed === key ? `Could not copy ${label}` : `Copy ${label}`
                }
                onClick={() => void copyIt()}
              >
                {copied === key ? (
                  <IconCheck size={17} />
                ) : (
                  <IconCopy size={17} />
                )}
              </button>
            ) : null}
          </>
        ) : undefined
      }
    >
      <ConcealedValue
        value={shown ?? ""}
        label={field.label}
        revealed={shown !== null}
      />
      {denied ? <StatusMark tone="err" label="The owner refused" /> : null}
    </EditableRow>
  );
}

function OpenField({
  item,
  field,
  canEdit,
  save,
}: {
  item: SharedItem;
  field: SharedField;
  canEdit: boolean;
  save?: SaveField;
}) {
  const [saved, setSaved] = useState<string | null>(null);
  return (
    <EditableRow
      fieldLabel={field.label}
      editLabel={`${item.name} ${field.label}`}
      canEdit={canEdit}
      save={save ? (value) => save(item.id, field.key, value) : undefined}
      onSaved={setSaved}
    >
      <span className="frow__value">{saved ?? field.value}</span>
    </EditableRow>
  );
}

function LiveItem({
  item,
  canReveal,
  canCopy,
  canEdit,
  request,
  save,
}: {
  item: SharedItem;
  canReveal: boolean;
  canCopy: boolean;
  canEdit: boolean;
  request: RequestField;
  save?: SaveField;
}) {
  return (
    <li className="panel live-item">
      <div className="panel__head">
        <h2>{item.name}</h2>
        <span className="vault-row__meta">{item.type}</span>
      </div>
      <div className="panel__body">
        {item.fields.map((field) =>
          field.concealed ? (
            <ConcealedField
              key={field.key}
              item={item}
              field={field}
              canReveal={canReveal}
              canCopy={canCopy}
              canEdit={canEdit}
              request={request}
              save={save}
            />
          ) : (
            <OpenField
              key={field.key}
              item={item}
              field={field}
              canEdit={canEdit}
              save={save}
            />
          ),
        )}
      </div>
    </li>
  );
}

export function LiveCatalog({
  catalog,
  request,
  save,
}: {
  catalog: Catalog;
  request: RequestField;
  save?: SaveField;
}) {
  if (catalog.items.length === 0)
    return <StatusMark tone="idle" label="Nothing is shared yet" />;
  const canEdit = catalog.policy === "edit" && save !== undefined;
  // Copy only (`use`) must not place concealed plaintext on this clipboard.
  const canCopy = catalog.policy !== "use";
  return (
    <ul className="live-items" aria-label={catalog.title}>
      {catalog.items.map((item) => (
        <LiveItem
          key={item.id}
          item={item}
          canReveal={catalog.policy === "read" || catalog.policy === "edit"}
          canCopy={canCopy}
          canEdit={canEdit}
          request={request}
          save={save}
        />
      ))}
    </ul>
  );
}

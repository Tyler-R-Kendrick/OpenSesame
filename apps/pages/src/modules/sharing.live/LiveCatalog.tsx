/**
 * What a joined live session shows (ADR 0148 §5): the shared items, their
 * open fields as the owner sent them, and each concealed field as a key that
 * asks the owner for it. A value the owner answers is held in this
 * component's state only — never written anywhere — and goes when the
 * person hides it, leaves, or the session ends.
 *
 * `use` sessions copy without drawing: the owner refuses `reveal`, and the
 * reveal key is not drawn.
 */

import type {
  Catalog,
  SharedField,
  SharedItem,
} from "@opensesame/app-core/lib/live/messages.js";
import { useState } from "react";
import {
  ConcealedValue,
  FieldRow,
  RevealButton,
  useCopyFeedback,
} from "../../components/FieldRow.js";
import { IconCheck, IconCopy } from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";

export type RequestField = (
  what: "reveal" | "copy",
  item: string,
  field: string,
) => Promise<string | null>;

function ConcealedField({
  item,
  field,
  canReveal,
  request,
}: {
  item: SharedItem;
  field: SharedField;
  canReveal: boolean;
  request: RequestField;
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
    const value = await request("copy", item.id, field.key);
    setDenied(value === null);
    if (value !== null) await copy(key, value);
  }

  return (
    <FieldRow
      label={field.label}
      actions={
        <>
          {canReveal ? (
            <RevealButton
              revealed={shown !== null}
              label={label}
              onToggle={() => void toggle()}
            />
          ) : null}
          <button
            type="button"
            className={`icon-btn${copied === key ? " is-on" : ""}`}
            aria-label={
              failed === key ? `Could not copy ${label}` : `Copy ${label}`
            }
            title={failed === key ? `Could not copy ${label}` : `Copy ${label}`}
            onClick={() => void copyIt()}
          >
            {copied === key ? <IconCheck size={17} /> : <IconCopy size={17} />}
          </button>
        </>
      }
    >
      <ConcealedValue
        value={shown ?? ""}
        label={field.label}
        revealed={shown !== null}
      />
      {denied ? <StatusMark tone="err" label="The owner refused" /> : null}
    </FieldRow>
  );
}

function LiveItem({
  item,
  canReveal,
  request,
}: {
  item: SharedItem;
  canReveal: boolean;
  request: RequestField;
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
              request={request}
            />
          ) : (
            <FieldRow key={field.key} label={field.label}>
              <span className="frow__value">{field.value}</span>
            </FieldRow>
          ),
        )}
      </div>
    </li>
  );
}

export function LiveCatalog({
  catalog,
  request,
}: {
  catalog: Catalog;
  request: RequestField;
}) {
  if (catalog.items.length === 0)
    return <StatusMark tone="idle" label="Nothing is shared yet" />;
  return (
    <ul className="live-items" aria-label={catalog.title}>
      {catalog.items.map((item) => (
        <LiveItem
          key={item.id}
          item={item}
          canReveal={catalog.policy === "read"}
          request={request}
        />
      ))}
    </ul>
  );
}

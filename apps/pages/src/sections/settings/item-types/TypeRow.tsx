/**
 * One item type, one row: the extension it wears in the vault tree, its
 * title, one mono line of facts, and the row's state and action at the end.
 * The extension leads because it is how the type reads everywhere else — an
 * item is `name.ext` in the tree (ADR 0064/0073).
 */

import { publisherLabel } from "@opensesame/app-core/sections/settings/item-type-marketplace-model.js";
import {
  type ItemTypeDefinition,
  definitionFields,
  isConcealedFieldType,
  isFieldTypeId,
} from "@opensesame/vault-item-types";
import type { ReactNode } from "react";
import { IconLock } from "../../../components/Icons.js";

export function typeFacts(definition: ItemTypeDefinition): string {
  const count = definitionFields(definition).length;
  return [
    publisherLabel(definition.metadata.publisher),
    definition.metadata.version,
    count === 1 ? "1 field" : `${count} fields`,
  ].join(" · ");
}

export function TypeRow({
  definition,
  summary = false,
  trailing,
  children,
}: {
  definition: ItemTypeDefinition;
  /** Marketplace rows carry the author's one-line summary. */
  summary?: boolean;
  trailing?: ReactNode;
  /** An expanded detail — the fields, when a row is inspected. */
  children?: ReactNode;
}) {
  return (
    <li className="itype">
      <div className="itype__row">
        <span className="itype__ext">{definition.spec.extension}</span>
        <span className="itype__text">
          <span className="itype__name">{definition.spec.title}</span>
          {summary ? (
            <span className="itype__summary">{definition.spec.summary}</span>
          ) : null}
          <span className="itype__meta">{typeFacts(definition)}</span>
        </span>
        {trailing ? <span className="itype__end">{trailing}</span> : null}
      </div>
      {children}
    </li>
  );
}

/** The fields a definition declares, concealed ones marked with the lock. */
export function FieldList({
  fields,
  label,
}: {
  fields: readonly { id: string; label: string; type: string }[];
  label: string;
}) {
  return (
    <ul className="itype__fields" aria-label={label}>
      {fields.map((field) => (
        <li key={field.id}>
          <span>{field.label}</span>
          <code>{field.type}</code>
          {concealed(field.type) ? (
            <span
              className="itype__concealed"
              role="img"
              aria-label="Concealed, never searchable"
              title="Concealed, never searchable"
            >
              <IconLock size={12} />
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function concealed(type: string): boolean {
  return isFieldTypeId(type) && isConcealedFieldType(type);
}

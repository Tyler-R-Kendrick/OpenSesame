/**
 * The built-in item types, grouped by what they are for, each a switch
 * (ADR 0165). A search field narrows the list by any word of a type's title,
 * extension or summary — on a phone, eighteen rows are a scroll, and the
 * field is how a person gets to Wi-Fi without it.
 */

import type {
  PackGroup,
  PackRow,
} from "@opensesame/app-core/sections/settings/item-type-packs-model.js";
import { FieldShell } from "../../../components/FieldShell.js";
import { IconSearch, IconX } from "../../../components/Icons.js";
import { PackRowView } from "./PackRow.js";

export function PackList({
  groups,
  query,
  onQuery,
  onToggle,
}: {
  groups: readonly PackGroup[];
  query: string;
  onQuery: (next: string) => void;
  onToggle: (row: PackRow) => void;
}) {
  return (
    <div className="pack-list">
      <div className="pack-search">
        <FieldShell
          id="item-type-search"
          label="Search item types"
          mono
          type="text"
          placeholder="Search item types"
          lead={<IconSearch size={17} />}
          value={query}
          onValueChange={onQuery}
          tail={
            query === "" ? undefined : (
              <button
                type="button"
                className="icon-btn"
                aria-label="Clear search"
                title="Clear search"
                onClick={() => onQuery("")}
              >
                <IconX size={16} />
              </button>
            )
          }
        />
      </div>
      {groups.length === 0 ? (
        <p className="itype-empty">No item type matches “{query.trim()}”.</p>
      ) : (
        groups.map((group) => (
          <section
            key={group.id}
            className="pack-group"
            aria-labelledby={`pack-group-${group.id}`}
          >
            <h3 className="pack-group__label" id={`pack-group-${group.id}`}>
              {group.label}
            </h3>
            <ul className="itype-list">
              {group.rows.map((row) => (
                <PackRowView key={row.id} row={row} onToggle={onToggle} />
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}

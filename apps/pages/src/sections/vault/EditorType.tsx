import { Link } from "react-router";
import { EmptyTip, emptyTips } from "../../components/EmptyTip.js";
import { isCreatableItemKind } from "../../lib/item-kinds.js";
import { itemTypeRegistry, typeExtension } from "../../lib/vault/item-types.js";

export function UnknownItemType() {
  return (
    <div className="detail">
      <div className="empty">
        <h2>Unknown item type</h2>
        <p>This type is not installed on this device.</p>
        <EmptyTip>{emptyTips.keymap}</EmptyTip>
        <Link className="btn btn--sm" to="/vault/new">
          Choose an item type
        </Link>
      </div>
    </div>
  );
}

/** A route-selected or existing type is a label, never an editable field. */
export function EditorType({
  typeId,
  onChange,
}: { typeId: string; onChange?: (typeId: string) => void }) {
  if (!onChange) {
    return <span className="editor__ext">{typeExtension(typeId)}</span>;
  }
  return (
    <select
      className="editor__ext"
      aria-label="Type"
      value={typeId}
      onChange={(event) => {
        if (
          itemTypeRegistry().has(event.target.value) &&
          isCreatableItemKind(event.target.value)
        )
          onChange(event.target.value);
      }}
    >
      {itemTypeRegistry()
        .list()
        // Only kinds this installation may create are offered (SURFACE-08);
        // a community type is creatable like the core ones, an excluded
        // capability's kind is not.
        .filter(({ definition }) =>
          isCreatableItemKind(definition.metadata.id),
        )
        .map(({ definition }) => (
          <option key={definition.metadata.id} value={definition.metadata.id}>
            {definition.spec.extension}
          </option>
        ))}
    </select>
  );
}

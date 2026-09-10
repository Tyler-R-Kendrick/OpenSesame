import { Link } from "react-router";
import { itemTypeRegistry, typeExtension } from "../../lib/vault/item-types.js";

export function UnknownItemType() {
  return (
    <div className="detail">
      <div className="empty">
        <h2>Unknown item type</h2>
        <p>This type is not installed on this device.</p>
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
        if (itemTypeRegistry().has(event.target.value))
          onChange(event.target.value);
      }}
    >
      {itemTypeRegistry()
        .list()
        .map(({ definition }) => (
          <option key={definition.metadata.id} value={definition.metadata.id}>
            {definition.spec.extension}
          </option>
        ))}
    </select>
  );
}

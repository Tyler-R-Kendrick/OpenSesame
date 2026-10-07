import { isCreatableItemKind } from "@opensesame/app-core/lib/item-kinds.js";
import { FIELD_LIMITS } from "@opensesame/app-core/lib/vault/field-limits.js";
import {
  type TypeChoice,
  exactType,
  typeSuggestions,
} from "@opensesame/app-core/lib/vault/path-suggest.js";
import { itemTypeRegistry, typeExtension } from "@opensesame/vault-core";
import { Link } from "react-router";
import { EmptyTip } from "../../components/EmptyTip.js";
import { PathSegment } from "./PathSegment.js";

export function UnknownItemType() {
  return (
    <div className="detail">
      <div className="empty">
        <h2>Unknown item type</h2>
        <p>This type is not installed on this device.</p>
        <EmptyTip tip="keymap" />
        <Link className="btn btn--sm" to="/vault/new">
          Choose an item type
        </Link>
      </div>
    </div>
  );
}

/** The types this installation may create, as the type segment lists them. */
function creatableTypes(): TypeChoice[] {
  return (
    itemTypeRegistry()
      .list()
      // Only kinds this installation may create are offered (SURFACE-08);
      // a community type is creatable like the core ones, an excluded
      // capability's kind is not.
      .filter(({ definition }) => isCreatableItemKind(definition.metadata.id))
      .map(({ definition }) => ({
        id: definition.metadata.id,
        extension: definition.spec.extension,
        title: definition.spec.title,
      }))
  );
}

/**
 * The file type, always last in the row: `.login`. A route-selected or
 * existing type is a label; on a new item with no route it is chosen, and only
 * from the types there are.
 */
export function EditorType({
  typeId,
  onChange,
}: { typeId: string; onChange?: (typeId: string) => void }) {
  if (!onChange) {
    return (
      <span className="editor__ext pathfield__ext">
        {typeExtension(typeId)}
      </span>
    );
  }
  const types = creatableTypes();
  return (
    <PathSegment
      label="Type"
      tone="type"
      text={typeExtension(typeId)}
      suggest={(query) => typeSuggestions(types, query)}
      exact={(query) => exactType(types, query)}
      onPick={(key) => {
        if (itemTypeRegistry().has(key) && isCreatableItemKind(key))
          onChange(key);
      }}
      maxLength={FIELD_LIMITS.extension}
    />
  );
}

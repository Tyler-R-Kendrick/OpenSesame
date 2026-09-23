import type { EditorMode } from "@opensesame/app-core/lib/configuration/draft.js";
import { itemTypeRegistry } from "@opensesame/app-core/lib/vault/item-types.js";
import { fieldsOfDefinition } from "@opensesame/app-core/sections/settings/item-type-fields.js";
import { useMemo, useState } from "react";
import { ModeToggle } from "../../components/configuration/ModeToggle.js";

export function ItemTypeVisual(props: {
  draft: string;
  onDraft: (text: string) => void;
}) {
  const [mode, setMode] = useState<EditorMode>("source");
  const fields = useMemo(() => fieldsOfDefinition(props.draft), [props.draft]);
  const installed = itemTypeRegistry().list();
  return (
    <>
      <ModeToggle mode={mode} onMode={setMode} />
      {mode === "visual" ? (
        <ul className="itype-list" aria-label="Definition fields">
          {fields.length === 0 ? (
            <li className="hint">Paste JSON source to inspect fields.</li>
          ) : (
            fields.map((field) => (
              <li key={field.id}>
                {field.label} <code>{field.type}</code>
                {field.type === "concealed" ? " (never searchable)" : ""}
              </li>
            ))
          )}
        </ul>
      ) : (
        <textarea
          id="item-type-definition"
          rows={8}
          spellCheck={false}
          aria-label="Add a type"
          placeholder='{"apiVersion":"opensesame.dev/v1alpha1","kind":"VaultItemType",…}'
          value={props.draft}
          onChange={(event) => props.onDraft(event.target.value)}
        />
      )}
      <p className="hint">
        {installed.length} type(s) available. Removing a type does not rewrite
        item values.
      </p>
    </>
  );
}

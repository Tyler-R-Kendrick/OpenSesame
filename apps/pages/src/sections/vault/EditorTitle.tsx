import type { Folder } from "@opensesame/vault-core";
import { IconKey } from "../../components/IconKey.js";
import { IconStar } from "../../components/Icons.js";
import { isTouchPointer } from "../../lib/gestures.js";
import { EditorFolder } from "./EditorFolder.js";
import { EditorType } from "./EditorType.js";

export function EditorTitle({
  value,
  folders,
  onName,
  onFolder,
  onBlur,
  typeId,
  onTypeChange,
  placeholder = "Untitled",
  focusName = false,
  onPin,
}: {
  value: { name: string; folderId: string | null; favorite?: boolean };
  folders: Folder[];
  onName: (name: string) => void;
  onFolder: (folderId: string | null) => void;
  onBlur: () => void;
  typeId: string;
  onTypeChange?: (typeId: string) => void;
  placeholder?: string;
  focusName?: boolean;
  /** Pin to the top of the list: a pressed star on the title, not a form row. */
  onPin?: (pinned: boolean) => void;
}) {
  return (
    <div className="editor__titlerow">
      <EditorFolder
        value={value.folderId}
        folders={folders}
        onChange={onFolder}
      />
      <input
        className="editor__name"
        aria-label="Name"
        value={value.name}
        placeholder={placeholder}
        onChange={(event) => onName(event.target.value)}
        onBlur={onBlur}
        // biome-ignore lint/a11y/noAutofocus: explicit new/edit action focuses the name on desktop, never opening a mobile keyboard
        autoFocus={focusName && !isTouchPointer()}
      />
      <EditorType typeId={typeId} onChange={onTypeChange} />
      {onPin ? (
        <IconKey
          label={value.favorite ? "Unpin item" : "Pin item"}
          small
          aria-pressed={Boolean(value.favorite)}
          onClick={() => onPin(!value.favorite)}
        >
          <IconStar size={16} filled={Boolean(value.favorite)} />
        </IconKey>
      ) : null}
    </div>
  );
}

import { isTouchPointer } from "../../lib/gestures.js";
import type { Folder } from "../../lib/vault/model.js";
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
}: {
  value: { name: string; folderId: string | null };
  folders: Folder[];
  onName: (name: string) => void;
  onFolder: (folderId: string | null) => void;
  onBlur: () => void;
  typeId: string;
  onTypeChange?: (typeId: string) => void;
  placeholder?: string;
  focusName?: boolean;
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
    </div>
  );
}

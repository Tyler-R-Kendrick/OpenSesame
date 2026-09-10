import type { Folder } from "../../lib/vault/model.js";

export function EditorFolder({
  value,
  folders,
  onChange,
}: {
  value: string | null;
  folders: Folder[];
  onChange: (folderId: string | null) => void;
}) {
  return (
    <select
      className="editor__folder"
      aria-label="Folder"
      value={value ?? ""}
      onChange={(event) => onChange(event.target.value || null)}
    >
      <option value="">./</option>
      {folders.map((folder) => (
        <option key={folder.id} value={folder.id}>
          {folder.name}/
        </option>
      ))}
    </select>
  );
}

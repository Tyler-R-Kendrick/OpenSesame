import { FIELD_LIMITS } from "@opensesame/app-core/lib/vault/field-limits.js";
import { resolveItemPath } from "@opensesame/app-core/lib/vault/item-path.js";
import {
  exactFolder,
  folderSuggestions,
  parseFolderKey,
} from "@opensesame/app-core/lib/vault/path-suggest.js";
import type { Folder } from "@opensesame/vault-core";
import { PathSegment } from "./PathSegment.js";

/**
 * The folder, always first in the row: `./` for the vault root, `Work/` for a
 * folder. Chosen from the folders there are, or a path that makes a new one.
 */
export function EditorFolder({
  value,
  folders,
  onChange,
  onPicked,
}: {
  value: string | null;
  folders: Folder[];
  onChange: (folder: Folder | null) => void;
  onPicked?: () => void;
}) {
  const current = folders.find((folder) => folder.id === value);
  const pick = (key: string) => {
    const choice = parseFolderKey(key);
    if (choice?.kind === "root") onChange(null);
    else if (choice?.kind === "folder")
      onChange(folders.find((folder) => folder.id === choice.id) ?? null);
    else if (choice?.kind === "new")
      // Rooted, so `Work/Taxes` is that path and not one under the folder now chosen.
      onChange(
        resolveItemPath(`/${choice.path}/_`, null, folders).folder ?? null,
      );
  };
  return (
    <PathSegment
      label="Folder"
      tone="folder"
      text={current ? `${current.name}/` : "./"}
      suggest={(query) => folderSuggestions(folders, query)}
      exact={(query) => exactFolder(folders, query)}
      onPick={pick}
      {...(onPicked ? { onPicked } : {})}
      maxLength={FIELD_LIMITS.folder}
    />
  );
}

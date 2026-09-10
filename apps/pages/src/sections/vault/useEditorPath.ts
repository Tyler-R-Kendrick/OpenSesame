import { useState } from "react";
import { resolveItemPath } from "../../lib/vault/item-path.js";
import type { Folder, VaultItem } from "../../lib/vault/model.js";

type EditorPathValue = Pick<VaultItem, "name" | "folderId">;

export function useEditorPath(
  value: EditorPathValue,
  folders: Folder[],
  change: (value: EditorPathValue) => void,
  report: (error: string | null) => void,
  initialFolder?: Folder,
) {
  const [pending, setPending] = useState<Folder | undefined>(initialFolder);
  const choices =
    pending && !folders.some((folder) => folder.id === pending.id)
      ? [...folders, pending]
      : folders;
  const resolve = () => resolveItemPath(value.name, value.folderId, choices);
  const blur = () => {
    try {
      const next = resolve();
      setPending(next.folder);
      change({ name: next.name, folderId: next.folderId });
      report(null);
      return next;
    } catch (error) {
      report(
        error instanceof Error ? error.message : "The item path is invalid.",
      );
    }
  };
  return { choices, resolve, blur, stage: setPending };
}

import { resolveItemPath } from "@opensesame/app-core/lib/vault/item-path.js";
import type { Folder, VaultItem } from "@opensesame/vault-core";
import { useState } from "react";

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
  /** The folder the person chose from the list: `undefined` is the root. */
  const select = (folder?: Folder) => {
    setPending(folder);
    change({ name: value.name, folderId: folder?.id ?? null });
    report(null);
  };
  /**
   * The name field as it is typed. A `/` ends a folder: everything before the
   * last one moves into the folder segment now, relative to the folder that is
   * chosen, and only the leaf stays in the field. A prefix that cannot resolve
   * yet (`../` at the root) stays as typed; leaving the field reports it.
   */
  const typed = (text: string) => {
    const cut = text.lastIndexOf("/") + 1;
    if (cut > 0) {
      try {
        const next = resolveItemPath(
          `${text.slice(0, cut)}_`,
          value.folderId,
          choices,
        );
        setPending(next.folder);
        change({ name: text.slice(cut), folderId: next.folderId });
        report(null);
        return;
      } catch {
        // Left as typed for the blur to report.
      }
    }
    change({ name: text, folderId: value.folderId });
  };
  return { choices, resolve, blur, select, typed, stage: setPending };
}

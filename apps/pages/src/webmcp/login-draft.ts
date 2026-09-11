import { useEffect, useRef } from "react";
import {
  applyLoginDraftPatch,
  bindLoginDraft,
  loginDraftView,
} from "../lib/vault/login-draft.js";
import type { Folder, VaultItem } from "../lib/vault/model.js";
import { setWebMcpEditorKind } from "./context.js";

/** Publishes the live login editor to WebMCP for as long as it is mounted. */
export function useWebMcpLoginDraft(
  draft: VaultItem | null,
  folders: Folder[],
  patch: (changes: Partial<VaultItem>) => void,
): void {
  const draftRef = useRef(draft);
  const foldersRef = useRef(folders);
  const patchRef = useRef(patch);
  draftRef.current = draft;
  foldersRef.current = folders;
  patchRef.current = patch;

  useEffect(() => {
    setWebMcpEditorKind(draft?.kind ?? null);
    if (draft?.kind !== "login") {
      return () => setWebMcpEditorKind(null);
    }
    const unbind = bindLoginDraft({
      read: () => {
        const current = draftRef.current;
        if (!current) throw new Error("login_form_unavailable");
        return loginDraftView(current, foldersRef.current);
      },
      patch: (changes) => {
        const current = draftRef.current;
        if (!current) throw new Error("login_form_unavailable");
        const applied = applyLoginDraftPatch(current, changes);
        patchRef.current(applied);
        return loginDraftView(
          { ...current, ...applied } as VaultItem,
          foldersRef.current,
        );
      },
    });
    return () => {
      unbind();
      setWebMcpEditorKind(null);
    };
  }, [draft?.kind]);
}

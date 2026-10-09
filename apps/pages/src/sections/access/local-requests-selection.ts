import type { LocalAccessRequest } from "@opensesame/app-core/lib/local-access-requests.js";
import type { PendingShare } from "@opensesame/app-core/lib/local-share-grants-approvals.js";
import { useLayoutEffect, useRef } from "react";
import { keyboardIsIdle, landFocus } from "../../lib/focus.js";
import { useAccessRecord } from "./AccessRecords.js";
import {
  landLocalRequestFocus,
  resolveLocalRequestSelection,
} from "./local-requests-focus.js";

export const GRANT_ROW_PREFIX = "grant:";

export function grantRowId(grantId: string) {
  return `${GRANT_ROW_PREFIX}${grantId}`;
}

export function useLocalRequestSelection(
  requests: LocalAccessRequest[] | undefined,
  pendingGrants: PendingShare[] | undefined,
) {
  const selection = useAccessRecord("local-requests", "requests");
  const {
    creating,
    setCreating,
    id: selectedId,
    select: setSelected,
  } = selection;
  const { selectedGrant, selected } = resolveLocalRequestSelection(
    selectedId,
    requests,
    pendingGrants,
  );
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const reload = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    if (selectedId && requests && !selected && !selectedGrant) {
      if (keyboardIsIdle()) landFocus(reload.current);
      setSelected(null);
      return;
    }
    landLocalRequestFocus({
      creating,
      selected,
      selectedGrant,
      root: root.current,
      trigger: trigger.current,
      reload: reload.current,
    });
  }, [creating, selected, selectedGrant, selectedId, requests, setSelected]);
  function close() {
    selection.close();
  }
  return {
    selection,
    creating,
    setCreating,
    selected,
    selectedGrant,
    root,
    trigger,
    reload,
    close,
  };
}

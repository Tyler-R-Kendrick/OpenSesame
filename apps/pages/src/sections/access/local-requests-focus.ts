import type { LocalAccessRequest } from "@opensesame/app-core/lib/local-access-requests.js";
import type { PendingShare } from "@opensesame/app-core/lib/local-share-grants-approvals.js";
import { keyboardIsIdle, landFocus } from "../../lib/focus.js";
import { grantRowId } from "./local-requests-selection.js";

export function resolveLocalRequestSelection(
  selectedId: string | null,
  requests: LocalAccessRequest[] | undefined,
  pendingGrants: PendingShare[] | undefined,
) {
  const selectedGrant =
    selectedId?.startsWith("grant:") && pendingGrants
      ? (pendingGrants.find((row) => grantRowId(row.id) === selectedId) ?? null)
      : null;
  const selected =
    selectedId && !selectedGrant
      ? (requests?.find((row) => row.id === selectedId) ?? null)
      : null;
  return { selectedGrant, selected };
}

export function landLocalRequestFocus(input: {
  creating: boolean;
  selected: LocalAccessRequest | null;
  selectedGrant: PendingShare | null;
  root: HTMLElement | null;
  trigger: HTMLElement | null;
  reload: HTMLButtonElement | null;
}) {
  const { creating, selected, selectedGrant, root, trigger, reload } = input;
  if (!trigger) return;
  if (!keyboardIsIdle() && document.activeElement !== trigger) return;
  if (creating || selected || selectedGrant) {
    landFocus(
      root?.querySelector("form select, fieldset select, fieldset button") ??
        null,
    );
    return;
  }
  landFocus(trigger.isConnected ? trigger : reload);
}

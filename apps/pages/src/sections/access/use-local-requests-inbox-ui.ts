import type { InboxStatusFilter } from "@opensesame/app-core/lib/configuration/inbox-triage.js";
import { type MutableRefObject, useState } from "react";
import type { useLocalRequests } from "./useLocalRequests.js";

export function useLocalRequestsInboxUi(
  model: ReturnType<typeof useLocalRequests>,
  requestSelection: {
    creating: boolean;
    selected: unknown;
    setCreating: (value: boolean) => void;
    setSelected: (value: string | null) => void;
    trigger: MutableRefObject<HTMLElement | null>;
  },
) {
  const [statusFilter, setStatusFilter] = useState<InboxStatusFilter>("all");
  const [selectedGrantId, setSelectedGrantId] = useState<string | null>(null);
  const selectedGrant =
    model.data?.pendingGrants.find((row) => row.id === selectedGrantId) ?? null;
  const disabled = model.busy || Boolean(model.error);
  const listDisabled =
    disabled ||
    requestSelection.creating ||
    requestSelection.selected !== null ||
    selectedGrant !== null;

  function selectGrant(rowId: string, button: HTMLButtonElement) {
    requestSelection.trigger.current = button;
    setSelectedGrantId(rowId);
    requestSelection.setSelected(null);
    requestSelection.setCreating(false);
  }

  function selectRequest(rowId: string, button: HTMLButtonElement) {
    requestSelection.trigger.current = button;
    requestSelection.setSelected(rowId);
    setSelectedGrantId(null);
    requestSelection.setCreating(false);
  }

  return {
    statusFilter,
    setStatusFilter,
    selectedGrant,
    selectedGrantId,
    closeGrant: () => setSelectedGrantId(null),
    disabled,
    listDisabled,
    selectGrant,
    selectRequest,
  };
}

import { useState } from "react";
import "./local-authority.css";
import "./access-record-choices.css";
import type { InboxStatusFilter } from "@opensesame/app-core/lib/configuration/inbox-triage.js";
import { FailureNotice } from "../../components/FailureNotice.js";
import { AccessRecords } from "./AccessRecords.js";
import { LocalRequestsCommands } from "./local-requests-commands.js";
import { LocalRequestsPanelBody } from "./local-requests-panel-body.js";
import { useLocalRequestSelection } from "./local-requests-selection.js";
import {
  requestWorkspaceRows,
  visiblePendingGrants,
  visibleRequests,
} from "./local-requests-visible.js";
import { useLocalRequests } from "./useLocalRequests.js";

export function LocalRequestsPanel({ tomb }: { tomb: string }) {
  const model = useLocalRequests(tomb);
  const [statusFilter, setStatusFilter] = useState<InboxStatusFilter>("all");
  const selectionState = useLocalRequestSelection(
    model.data?.requests,
    model.data?.pendingGrants,
  );
  const disabled = model.busy || Boolean(model.error);
  const requestRows = visibleRequests(model.data?.requests, statusFilter);
  const grantRows = visiblePendingGrants(
    model.data?.pendingGrants,
    model.data?.directory,
    statusFilter,
    selectionState.selection.path,
  );
  const rows = [
    ...grantRows,
    ...requestWorkspaceRows(
      requestRows,
      model.data?.directory,
      selectionState.selection.path,
    ),
  ];
  return (
    <AccessRecords
      title="Local requests"
      selection={selectionState.selection}
      rows={rows}
      commands={
        <LocalRequestsCommands
          statusFilter={statusFilter}
          setStatusFilter={setStatusFilter}
          disabled={disabled}
          loaded={Boolean(model.data)}
          creating={selectionState.creating}
          busy={model.busy}
          reloadRef={selectionState.reload}
          onReload={() => void model.reload()}
          onCreate={(button) => {
            selectionState.trigger.current = button;
            selectionState.setCreating(true);
          }}
        />
      }
      status={
        <>
          <FailureNotice
            id="access:requests"
            title="Requests"
            message={model.error}
          />
          <output>{model.message}</output>
        </>
      }
    >
      <LocalRequestsPanelBody
        root={selectionState.root}
        tomb={tomb}
        model={model}
        disabled={disabled}
        creating={selectionState.creating}
        selected={selectionState.selected}
        selectedGrant={selectionState.selectedGrant}
        close={selectionState.close}
      />
    </AccessRecords>
  );
}

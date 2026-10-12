/**
 * The Local requests panel's body: the new-request form, the open decision,
 * and the filtered rows (ADR 0162).
 */

import { FailureNotice } from "../../components/FailureNotice.js";
import { LocalRequestForm } from "./LocalRequestForm.js";
import {
  AccessRequestDecision,
  AccessRequestRows,
  type useRequestSelection,
} from "./local-access-request-inbox.js";
import {
  PendingGrantDecision,
  PendingGrantRows,
} from "./local-pending-grant-inbox.js";
import type { useLocalRequestsInboxUi } from "./use-local-requests-inbox-ui.js";
import type { useLocalRequests } from "./useLocalRequests.js";

export function LocalRequestsBody({
  tomb,
  model,
  ui,
  creating,
  selected,
  close,
}: {
  tomb: string;
  model: ReturnType<typeof useLocalRequests>;
  ui: ReturnType<typeof useLocalRequestsInboxUi>;
  creating: boolean;
  selected: ReturnType<typeof useRequestSelection>["selected"];
  close: () => void;
}) {
  return (
    <div className="panel__body">
      <FailureNotice
        id="access:requests"
        title="Requests"
        message={model.error}
      />
      <output>{model.message}</output>
      {creating && model.data ? (
        <LocalRequestForm
          tomb={tomb}
          directory={model.data.directory}
          applications={model.data.applications}
          busy={ui.disabled}
          run={model.run}
          close={close}
        />
      ) : null}
      {selected && model.data ? (
        <AccessRequestDecision
          key={selected.id}
          tomb={tomb}
          row={selected}
          directory={model.data.directory}
          busy={ui.disabled}
          run={model.run}
          close={close}
        />
      ) : null}
      {ui.selectedGrant && model.data ? (
        <PendingGrantDecision
          key={ui.selectedGrant.id}
          tomb={tomb}
          pending={ui.selectedGrant}
          directory={model.data.directory}
          busy={ui.disabled}
          run={model.run}
          close={ui.closeGrant}
        />
      ) : null}
      {model.data ? (
        <>
          <PendingGrantRows
            grants={model.data.pendingGrants}
            directory={model.data.directory}
            filter={ui.statusFilter}
            disabled={ui.listDisabled}
            select={(row, button) => ui.selectGrant(row.id, button)}
          />
          <AccessRequestRows
            data={model.data}
            filter={ui.statusFilter}
            disabled={ui.listDisabled}
            select={(row, button) => ui.selectRequest(row.id, button)}
          />
        </>
      ) : !model.error ? (
        <output>Loading local requests…</output>
      ) : null}
    </div>
  );
}

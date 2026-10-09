import "./local-authority.css";
import type { InboxStatusFilter } from "@opensesame/app-core/lib/configuration/inbox-triage.js";
import { FailureNotice } from "../../components/FailureNotice.js";
import { IconKey } from "../../components/IconKey.js";
import { IconPlus, IconRefresh } from "../../components/Icons.js";
import { LocalRequestForm } from "./LocalRequestForm.js";
import {
  AccessRequestDecision,
  AccessRequestRows,
  useRequestSelection,
} from "./local-access-request-inbox.js";
import {
  PendingGrantDecision,
  PendingGrantRows,
} from "./local-pending-grant-inbox.js";
import { useLocalRequestsInboxUi } from "./use-local-requests-inbox-ui.js";
import { useLocalRequests } from "./useLocalRequests.js";

export function LocalRequestsPanel({ tomb }: { tomb: string }) {
  const model = useLocalRequests(tomb);
  const {
    creating,
    setCreating,
    selected,
    setSelected,
    root,
    trigger,
    reload,
    close,
  } = useRequestSelection(model.data?.requests);
  const ui = useLocalRequestsInboxUi(model, {
    creating,
    selected,
    setCreating,
    setSelected,
    trigger,
  });
  return (
    <section
      className="panel"
      id="local-requests"
      aria-label="Local requests"
      ref={root}
    >
      <div className="panel__head">
        <h2>Local requests</h2>
        <div className="actions">
          <select
            className="head-filter"
            aria-label="Local request status filter"
            value={ui.statusFilter}
            onChange={(event) =>
              // SAFETY: test/fixture or boundary-checked value matches InboxStatusFilter).
              ui.setStatusFilter(event.target.value as InboxStatusFilter)
            }
          >
            <option value="pending">pending</option>
            <option value="expired">expired</option>
            <option value="decided">decided</option>
            <option value="all">all</option>
          </select>
          <IconKey
            small
            label="New local request"
            disabled={ui.disabled || !model.data || ui.listDisabled}
            onClick={(event) => {
              trigger.current = event.currentTarget;
              setCreating(true);
            }}
          >
            <IconPlus size={15} />
          </IconKey>
          <IconKey
            small
            label="Reload local requests"
            keyRef={reload}
            disabled={model.busy}
            onClick={() => void model.reload()}
          >
            <IconRefresh size={15} />
          </IconKey>
        </div>
      </div>
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
    </section>
  );
}

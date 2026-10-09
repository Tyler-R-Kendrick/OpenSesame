import { useState } from "react";
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
import { useLocalRequests } from "./useLocalRequests.js";

export function LocalRequestsPanel({ tomb }: { tomb: string }) {
  const model = useLocalRequests(tomb);
  const [statusFilter, setStatusFilter] = useState<InboxStatusFilter>("all");
  const [selectedGrantId, setSelectedGrantId] = useState<string | null>(null);
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
  const selectedGrant =
    model.data?.pendingGrants.find((row) => row.id === selectedGrantId) ?? null;
  const disabled = model.busy || Boolean(model.error);
  const listDisabled =
    disabled || creating || selected !== null || selectedGrant !== null;
  function closeGrant() {
    setSelectedGrantId(null);
  }
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
            value={statusFilter}
            onChange={(event) =>
              // SAFETY: test/fixture or boundary-checked value matches InboxStatusFilter).
              setStatusFilter(event.target.value as InboxStatusFilter)
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
            disabled={disabled || !model.data || listDisabled}
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
            busy={disabled}
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
            busy={disabled}
            run={model.run}
            close={close}
          />
        ) : null}
        {selectedGrant && model.data ? (
          <PendingGrantDecision
            key={selectedGrant.id}
            tomb={tomb}
            pending={selectedGrant}
            directory={model.data.directory}
            busy={disabled}
            run={model.run}
            close={closeGrant}
          />
        ) : null}
        {model.data ? (
          <>
            <PendingGrantRows
              grants={model.data.pendingGrants}
              directory={model.data.directory}
              filter={statusFilter}
              disabled={listDisabled}
              select={(row, button) => {
                trigger.current = button;
                setSelectedGrantId(row.id);
                setSelected(null);
                setCreating(false);
              }}
            />
            <AccessRequestRows
              data={model.data}
              filter={statusFilter}
              disabled={listDisabled}
              select={(row, button) => {
                trigger.current = button;
                setSelected(row.id);
                setSelectedGrantId(null);
                setCreating(false);
              }}
            />
          </>
        ) : !model.error ? (
          <output>Loading local requests…</output>
        ) : null}
      </div>
    </section>
  );
}

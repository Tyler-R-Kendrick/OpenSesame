import { type Ref, useLayoutEffect, useRef, useState } from "react";
import "./local-authority.css";
import "./access-record-choices.css";
import {
  type InboxStatusFilter,
  filterInboxRows,
} from "@opensesame/app-core/lib/configuration/inbox-triage.js";
import {
  type LocalAccessRequest,
  removeSettledLocalAccessRequest,
  revokeLocalAccessRequest,
} from "@opensesame/app-core/lib/local-access-requests.js";
import type { LocalDirectory } from "@opensesame/app-core/lib/local-directory.js";
import { FailureNotice } from "../../components/FailureNotice.js";
import { IconKey } from "../../components/IconKey.js";
import {
  IconPlus,
  IconRefresh,
  IconTrash,
  IconX,
} from "../../components/Icons.js";
import { keyboardIsIdle, landFocus } from "../../lib/focus.js";
import {
  AccessDetail,
  AccessFact,
  AccessRecords,
  useAccessRecord,
} from "./AccessRecords.js";
import { LocalRequestForm } from "./LocalRequestForm.js";
import { RequestApproval } from "./RequestApproval.js";
import { useLocalRequests } from "./useLocalRequests.js";

function useRequestSelection(requests: LocalAccessRequest[] | undefined) {
  const selection = useAccessRecord("local-requests", "requests");
  const {
    creating,
    setCreating,
    id: selectedId,
    select: setSelected,
  } = selection;
  const selected = requests?.find((row) => row.id === selectedId) ?? null;
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const reload = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    if (selectedId && requests && !selected) {
      if (keyboardIsIdle()) landFocus(reload.current);
      setSelected(null);
      return;
    }
    if (!trigger.current) return;
    if (!keyboardIsIdle() && document.activeElement !== trigger.current) return;
    if (creating || selected)
      landFocus(
        root.current?.querySelector(
          "form select, fieldset select, fieldset button",
        ) ?? null,
      );
    else
      landFocus(
        trigger.current?.isConnected ? trigger.current : reload.current,
      );
  }, [creating, selected, selectedId, requests, setSelected]);
  function close() {
    selection.close();
  }
  return {
    selection,
    creating,
    setCreating,
    selected,
    root,
    trigger,
    reload,
    close,
  };
}

export function LocalRequestsPanel({ tomb }: { tomb: string }) {
  const model = useLocalRequests(tomb);
  const [statusFilter, setStatusFilter] = useState<InboxStatusFilter>("all");
  const {
    selection,
    creating,
    setCreating,
    selected,
    root,
    trigger,
    reload,
    close,
  } = useRequestSelection(model.data?.requests);
  const disabled = model.busy || Boolean(model.error);
  const rows = visibleRequests(model.data?.requests, statusFilter);
  return (
    <AccessRecords
      title="Local requests"
      selection={selection}
      rows={requestWorkspaceRows(rows, model.data?.directory, selection.path)}
      commands={
        <RequestCommands
          statusFilter={statusFilter}
          setStatusFilter={setStatusFilter}
          disabled={disabled}
          loaded={Boolean(model.data)}
          creating={creating}
          busy={model.busy}
          reloadRef={reload}
          onReload={() => void model.reload()}
          onCreate={(button) => {
            trigger.current = button;
            setCreating(true);
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
      <div ref={root}>
        {creating && model.data ? (
          <AccessDetail title="New local request" kind="Request">
            <LocalRequestForm
              tomb={tomb}
              directory={model.data.directory}
              applications={model.data.applications}
              busy={disabled}
              run={model.run}
              close={close}
            />
          </AccessDetail>
        ) : null}
        {!creating && selected && model.data ? (
          <RequestDecision
            key={selected.id}
            tomb={tomb}
            row={selected}
            directory={model.data.directory}
            busy={disabled}
            run={model.run}
            close={close}
          />
        ) : null}
        {!model.data && !model.error ? (
          <output>Loading local requests…</output>
        ) : null}
      </div>
    </AccessRecords>
  );
}

function RequestDecision({
  tomb,
  row,
  directory,
  busy,
  run,
  close,
}: {
  tomb: string;
  row: LocalAccessRequest;
  directory: LocalDirectory;
  busy: boolean;
  run: (
    action: () => Promise<LocalAccessRequest> | Promise<void>,
    success: string,
  ) => Promise<boolean>;
  close: () => void;
}) {
  const [removing, setRemoving] = useState(false);
  const name = (value: string) =>
    directory.entries.find((entry) => entry.id === value)?.name ?? value;
  const active = row.status === "pending" || row.status === "approved";
  const removeLabel = removing
    ? active
      ? "Confirm withdrawal"
      : "Confirm history removal"
    : active
      ? "Withdraw request"
      : "Remove request history";
  async function remove() {
    if (!removing) {
      setRemoving(true);
      return;
    }
    if (
      await run(
        () =>
          active
            ? revokeLocalAccessRequest(tomb, row)
            : removeSettledLocalAccessRequest(tomb, row),
        active ? "Request withdrawn." : "Request history removed.",
      )
    )
      close();
  }
  return (
    <AccessDetail
      title={name(row.applicationId)}
      kind="Request"
      actions={
        <>
          <IconKey
            label={removeLabel}
            disabled={busy}
            onClick={() => void remove()}
          >
            <IconTrash size={16} />
          </IconKey>
          <IconKey label="Close request" onClick={close}>
            <IconX size={16} />
          </IconKey>
        </>
      }
    >
      <fieldset className="access-record-review" disabled={busy}>
        <legend className="visually-hidden">Review local request</legend>
        <AccessFact label="Requester" value={name(row.requesterId)} />
        <AccessFact label="Organization" value={name(row.organizationId)} />
        <AccessFact label="Reason" value={row.reason} />
        <AccessFact label="Reference" value={row.id} />
        <AccessFact label="Status" value={row.status} />
        <AccessFact label="Scopes" value={row.scopes.join(", ")} />
        <AccessFact label="Callback" value={row.redirectUri} />
        {row.status === "pending" ? (
          <RequestApproval
            tomb={tomb}
            row={row}
            directory={directory}
            run={run}
            close={close}
          />
        ) : null}
      </fieldset>
    </AccessDetail>
  );
}

function RequestCommands({
  statusFilter,
  setStatusFilter,
  disabled,
  loaded,
  creating,
  busy,
  reloadRef,
  onReload,
  onCreate,
}: {
  statusFilter: InboxStatusFilter;
  setStatusFilter: (next: InboxStatusFilter) => void;
  disabled: boolean;
  loaded: boolean;
  creating: boolean;
  busy: boolean;
  reloadRef: Ref<HTMLButtonElement>;
  onReload: () => void;
  onCreate: (button: HTMLButtonElement) => void;
}) {
  return (
    <>
      <select
        className="head-filter"
        aria-label="Local request status filter"
        value={statusFilter}
        onChange={(event) => {
          const next = event.target.value;
          if (
            next === "pending" ||
            next === "expired" ||
            next === "decided" ||
            next === "all"
          )
            setStatusFilter(next);
        }}
      >
        <option value="pending">pending</option>
        <option value="expired">expired</option>
        <option value="decided">decided</option>
        <option value="all">all</option>
      </select>
      <IconKey
        small
        label="New local request"
        disabled={disabled || !loaded || creating}
        onClick={(event) => {
          onCreate(event.currentTarget);
        }}
      >
        <IconPlus size={15} />
      </IconKey>
      <IconKey
        small
        label="Reload local requests"
        keyRef={reloadRef}
        disabled={busy}
        onClick={onReload}
      >
        <IconRefresh size={15} />
      </IconKey>
    </>
  );
}

function requestWorkspaceRows(
  rows: readonly LocalAccessRequest[],
  directory: LocalDirectory | undefined,
  path: (id: string) => string,
) {
  return rows.map((row) => ({
    id: row.id,
    label:
      directory?.entries.find((entry) => entry.id === row.applicationId)
        ?.name ?? row.applicationId,
    extension: "request",
    to: path(row.id),
  }));
}

function visibleRequests(
  requests: LocalAccessRequest[] | undefined,
  statusFilter: InboxStatusFilter,
) {
  const visibleIds = new Set(
    filterInboxRows(
      (requests ?? []).map((row) => ({
        id: row.id,
        status: row.status,
        expiresAt: new Date(row.expiresAt).toISOString(),
        plane: "local" as const,
      })),
      statusFilter,
    ).map((row) => row.id),
  );
  const rows = (requests ?? []).filter((row) => visibleIds.has(row.id));
  return rows;
}

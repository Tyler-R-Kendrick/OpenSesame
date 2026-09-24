import { useLayoutEffect, useRef, useState } from "react";
import "./local-authority.css";
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
import { IconPlus, IconRefresh } from "../../components/Icons.js";
import { keyboardIsIdle, landFocus } from "../../lib/focus.js";
import { LocalRequestForm } from "./LocalRequestForm.js";
import { RequestApproval } from "./RequestApproval.js";
import { useLocalRequests } from "./useLocalRequests.js";

function useRequestSelection(requests: LocalAccessRequest[] | undefined) {
  const [creating, setCreating] = useState(false);
  const [selectedId, setSelected] = useState<string | null>(null);
  const selected = requests?.find((row) => row.id === selectedId) ?? null;
  const root = useRef<HTMLElement>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const reload = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    if (selectedId && requests && !selected) setSelected(null);
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
  }, [creating, selected, selectedId, requests]);
  function close() {
    setCreating(false);
    setSelected(null);
  }
  return {
    creating,
    setCreating,
    selected,
    setSelected,
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
    creating,
    setCreating,
    selected,
    setSelected,
    root,
    trigger,
    reload,
    close,
  } = useRequestSelection(model.data?.requests);
  const disabled = model.busy || Boolean(model.error);
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
          <button
            type="button"
            className="icon-btn"
            title="New local request"
            aria-label="New local request"
            disabled={disabled || !model.data || creating || selected !== null}
            onClick={(event) => {
              trigger.current = event.currentTarget;
              setCreating(true);
            }}
          >
            <IconPlus />
          </button>
          <button
            type="button"
            className="icon-btn"
            ref={reload}
            title="Reload local requests"
            aria-label="Reload local requests"
            disabled={model.busy}
            onClick={() => void model.reload()}
          >
            <IconRefresh />
          </button>
        </div>
      </div>
      <div className="panel__body">
        {model.error ? (
          <p className="note note--err" role="alert">
            {model.error}
          </p>
        ) : null}
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
        {model.data ? (
          <RequestRows
            data={model.data}
            filter={statusFilter}
            disabled={disabled || creating || selected !== null}
            select={(row, button) => {
              trigger.current = button;
              setSelected(row.id);
            }}
          />
        ) : !model.error ? (
          <output>Loading local requests…</output>
        ) : null}
      </div>
    </section>
  );
}

function RequestRows({
  data,
  filter,
  disabled,
  select,
}: {
  data: NonNullable<ReturnType<typeof useLocalRequests>["data"]>;
  filter: InboxStatusFilter;
  disabled: boolean;
  select: (row: LocalAccessRequest, button: HTMLButtonElement) => void;
}) {
  const visibleIds = new Set(
    filterInboxRows(
      data.requests.map((row) => ({
        id: row.id,
        status: row.status,
        expiresAt: new Date(row.expiresAt).toISOString(),
        plane: "local" as const,
      })),
      filter,
    ).map((row) => row.id),
  );
  const rows = data.requests.filter((row) => visibleIds.has(row.id));
  return (
    <>
      <p className="hint">Requests: {rows.length || "-"}</p>
      <ul className="access-local-records">
        {rows.map((row) => (
          <li key={row.id}>
            <strong>
              {data.directory.entries.find(
                (entry) => entry.id === row.applicationId,
              )?.name ?? row.applicationId}
            </strong>
            <p>{row.reason}</p>
            <p className="hint">
              {row.status} · {row.scopes.join(", ")} · Expires{" "}
              {new Date(row.expiresAt).toLocaleTimeString()}
            </p>
            <p>
              <code className="access-ref">{row.id}</code>
            </p>
            <button
              type="button"
              className="btn btn--sm"
              disabled={disabled}
              onClick={(event) => select(row, event.currentTarget)}
            >
              Review request
            </button>
          </li>
        ))}
      </ul>
      {!rows.length ? (
        <p>No local requests. Create one for a registered application.</p>
      ) : null}
    </>
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
    <fieldset className="access-local-confirmation" disabled={busy}>
      <legend>Review local request</legend>
      <p>
        {name(row.requesterId)} → {name(row.applicationId)} ·{" "}
        {name(row.organizationId)}
      </p>
      <p>{row.reason}</p>
      <p>
        <code className="access-ref">{row.id}</code> · {row.status}
      </p>
      <p>Scopes: {row.scopes.join(", ")}</p>
      <p className="hint">Callback: {row.redirectUri}</p>
      {row.status === "pending" ? (
        <RequestApproval
          tomb={tomb}
          row={row}
          directory={directory}
          run={run}
          close={close}
        />
      ) : null}
      <div className="actions">
        <button type="button" className="btn" onClick={() => void remove()}>
          {removing
            ? active
              ? "Confirm withdrawal"
              : "Confirm history removal"
            : active
              ? "Withdraw request"
              : "Remove request history"}
        </button>
        <button type="button" className="btn" onClick={close}>
          Close request
        </button>
      </div>
    </fieldset>
  );
}

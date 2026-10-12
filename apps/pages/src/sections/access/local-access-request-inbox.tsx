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
import { useLayoutEffect, useRef, useState } from "react";
import { IconKey } from "../../components/IconKey.js";
import { IconArrowRight, IconTrash, IconX } from "../../components/Icons.js";
import { keyboardIsIdle, landFocus } from "../../lib/focus.js";
import { RequestApproval } from "./RequestApproval.js";
import type { useLocalRequests } from "./useLocalRequests.js";

export function useRequestSelection(
  requests: LocalAccessRequest[] | undefined,
) {
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

export function AccessRequestRows({
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
            <IconKey
              label="Review request"
              small
              disabled={disabled}
              onClick={(event) => select(row, event.currentTarget)}
            >
              <IconArrowRight size={16} />
            </IconKey>
          </li>
        ))}
      </ul>
      {!rows.length ? <p className="hint">No local requests.</p> : null}
    </>
  );
}

export function AccessRequestDecision({
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
        <IconKey label={removeLabel} onClick={() => void remove()}>
          <IconTrash size={16} />
        </IconKey>
        <IconKey label="Close request" onClick={close}>
          <IconX size={16} />
        </IconKey>
      </div>
    </fieldset>
  );
}

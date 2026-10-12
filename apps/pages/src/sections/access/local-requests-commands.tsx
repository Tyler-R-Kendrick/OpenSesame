import type { InboxStatusFilter } from "@opensesame/app-core/lib/configuration/inbox-triage.js";
import type { Ref } from "react";
import { IconKey } from "../../components/IconKey.js";
import { IconPlus, IconRefresh } from "../../components/Icons.js";

export function LocalRequestsCommands({
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

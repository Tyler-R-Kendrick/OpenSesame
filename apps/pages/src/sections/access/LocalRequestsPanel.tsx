import "./local-authority.css";
import type { InboxStatusFilter } from "@opensesame/app-core/lib/configuration/inbox-triage.js";
import { IconKey } from "../../components/IconKey.js";
import { IconPlus, IconRefresh } from "../../components/Icons.js";
import { useRequestSelection } from "./local-access-request-inbox.js";
import { LocalRequestsBody } from "./local-requests-body.js";
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
      <LocalRequestsBody
        tomb={tomb}
        model={model}
        ui={ui}
        creating={creating}
        selected={selected}
        close={close}
      />
    </section>
  );
}

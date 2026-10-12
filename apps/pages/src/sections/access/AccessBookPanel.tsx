import {
  accessBookVersion,
  listLocalGrants,
  removeLocalGrant,
  subscribeAccessBook,
} from "@opensesame/app-core/lib/access-book.js";
import { useSyncExternalStore } from "react";
import { IconTrash } from "../../components/Icons.js";
import {
  AccessDetail,
  AccessFact,
  AccessRecords,
  useAccessRecord,
} from "./AccessRecords.js";

/**
 * Grants this device holds in `access.book.v1` — independent of Host
 * delegations, so guest / no-Host still lists mint + import (ADR 0090).
 * No Connectivity wall here: Host setup stays on AccessAuthority's Connect.
 *
 * These are the grants the path bar's import and export keys move, so the
 * panel is named for that ("Portable grants"), not "On this device" — the
 * identity shares below are on this device too, and "No grants on this
 * device yet" above twelve of them was untrue. Empty, it draws nothing:
 * the book fills from the path bar, where its keys are.
 */
export function AccessBookPanel() {
  // Every write to the book re-renders this, wherever it came from: the
  // path bar's import, a remove here, or anything else that holds the book.
  useSyncExternalStore(subscribeAccessBook, accessBookVersion);
  const grants = listLocalGrants();

  const selection = useAccessRecord("access-book", "grants");
  const selected = grants.find((grant) => grant.id === selection.id);
  return (
    <AccessRecords
      title="Portable grants"
      selection={selection}
      rows={grants.map((grant) => ({
        id: grant.id,
        label: grant.title,
        extension: "grant",
        to: selection.path(grant.id),
      }))}
    >
      {selected ? (
        <AccessDetail
          title={selected.title}
          kind="Portable grant"
          actions={
            <button
              type="button"
              className="icon-btn"
              aria-label={`Remove ${selected.title}`}
              title={`Remove ${selected.title}`}
              onClick={() => {
                removeLocalGrant(selected.id);
                selection.close();
              }}
            >
              <IconTrash />
            </button>
          }
        >
          <AccessFact label="Resource" value={selected.resource} />
          <AccessFact label="Mode" value={selected.mode} />
          <AccessFact label="Reference" value={selected.id} />
        </AccessDetail>
      ) : null}
    </AccessRecords>
  );
}

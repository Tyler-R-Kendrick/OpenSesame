import { useEffect, useRef, useState } from "react";
import "./local-authority.css";
import { IconKey } from "../../components/IconKey.js";
import { IconRefresh, IconTrash, IconX } from "../../components/Icons.js";
import { StatusNote } from "../../components/StatusNote.js";
import { useFocusAfter } from "../../lib/use-focus-after.js";
import {
  AccessDetail,
  AccessFact,
  AccessRecords,
  useAccessRecord,
} from "./AccessRecords.js";
import {
  type LocalAuthorityRow,
  useLocalAuthority,
} from "./useLocalAuthority.js";

/**
 * One kind of local access record per panel: Access › Grants lists the
 * application grants and Access › Sessions the sign-in sessions, so neither
 * tab repeats the other's list or its empty line.
 */
export function LocalAuthorityPanel({
  tomb,
  records,
}: { tomb: string; records: LocalAuthorityRow["kind"] }) {
  const state = useLocalAuthority(tomb);
  const grantsOnly = records === "grant";
  const rows = state.rows?.filter((row) => row.kind === records);
  const selection = useAccessRecord(
    grantsOnly ? "local-grants" : "local-sessions",
    grantsOnly ? "grants" : "sessions",
  );
  const selected = rows?.find((row) => row.id === selection.id);
  const [pending, setPending] = useState<LocalAuthorityRow | null>(null);
  const reload = useRef<HTMLButtonElement>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const focusAfter = useFocusAfter(state.busy);
  function close() {
    setPending(null);
    // The row's key when it is still there, the panel's reload when the
    // revocation took the row with it.
    focusAfter(() =>
      trigger.current?.isConnected ? trigger.current : reload.current,
    );
  }
  return (
    <AccessRecords
      title={grantsOnly ? "Local application grants" : "Local sessions"}
      emptyMessage={authorityEmpty(state.error, rows, grantsOnly)}
      selection={selection}
      rows={(rows ?? []).map((row) => ({
        id: row.id,
        label: row.name,
        extension: records,
        to: selection.path(row.id),
      }))}
      commands={
        <IconKey
          label="Reload local access records"
          small
          keyRef={reload}
          disabled={state.busy}
          onClick={() => void state.reload()}
        >
          <IconRefresh size={15} />
        </IconKey>
      }
      status={
        <>
          <StatusNote
            message={state.error ? { tone: "err", text: state.error } : null}
          />
          <output>{state.message}</output>
        </>
      }
    >
      {selected ? (
        <AccessDetail
          title={selected.name}
          kind={records}
          actions={
            <IconKey
              label={`Revoke ${records}`}
              small
              disabled={state.busy || pending !== null}
              onClick={(event) => {
                trigger.current = event.currentTarget;
                setPending(selected);
              }}
            >
              <IconTrash size={16} />
            </IconKey>
          }
        >
          <AccessFact label="Access" value={selected.detail} />
          <AccessFact label="Reference" value={selected.id} />
          <AccessFact
            label="Expires"
            value={new Date(selected.expiresAt).toLocaleString()}
          />
          {pending ? (
            <ConfirmRevocation
              row={pending}
              busy={state.busy}
              close={close}
              revoke={state.revoke}
            />
          ) : null}
        </AccessDetail>
      ) : null}
      {!rows && !state.error ? (
        <output>Loading local access records…</output>
      ) : null}
    </AccessRecords>
  );
}

function ConfirmRevocation({
  row,
  busy,
  close,
  revoke,
}: {
  row: LocalAuthorityRow;
  busy: boolean;
  close: () => void;
  revoke: (row: LocalAuthorityRow) => Promise<boolean>;
}) {
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancel.current?.focus();
  }, []);
  return (
    <fieldset className="access-local-confirmation" disabled={busy}>
      <legend>Confirm local revocation</legend>
      <p>
        Revoke {row.kind} for {row.name}?
      </p>
      <p className="hint">Record {row.id}. Cannot be undone.</p>
      <div className="actions">
        <IconKey
          label="Confirm revocation"
          onClick={() =>
            void revoke(row).then((done) => {
              if (done) close();
            })
          }
        >
          <IconTrash size={16} />
        </IconKey>
        <IconKey label="Cancel revocation" keyRef={cancel} onClick={close}>
          <IconX size={16} />
        </IconKey>
      </div>
    </fieldset>
  );
}

function authorityEmpty(
  error: string,
  rows: readonly LocalAuthorityRow[] | null | undefined,
  grantsOnly: boolean,
) {
  if (error) return "Unavailable";
  if (!rows) return "Loading…";
  return grantsOnly ? "No grants." : "No sessions.";
}

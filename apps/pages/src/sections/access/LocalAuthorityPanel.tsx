import { useEffect, useRef, useState } from "react";
import "./local-authority.css";
import { IconRefresh, IconTrash, IconX } from "../../components/Icons.js";
import { StatusNote } from "../../components/StatusNote.js";
import { keyboardIsIdle } from "../../lib/focus.js";
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
  const [pending, setPending] = useState<LocalAuthorityRow | null>(null);
  const reload = useRef<HTMLButtonElement>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  function close() {
    setPending(null);
    requestAnimationFrame(() => {
      if (keyboardIsIdle())
        (trigger.current?.isConnected
          ? trigger.current
          : reload.current
        )?.focus();
    });
  }
  return (
    <section
      className="panel"
      id={grantsOnly ? "local-grants" : "local-sessions"}
      aria-label="Local access records"
      aria-busy={state.busy}
    >
      <div className="panel__head">
        <h2>{grantsOnly ? "Local application grants" : "Local sessions"}</h2>
        <button
          ref={reload}
          type="button"
          className="icon-btn"
          aria-label="Reload local access records"
          title="Reload local access records"
          disabled={state.busy}
          onClick={() => void state.reload()}
        >
          <IconRefresh />
        </button>
      </div>
      <div className="panel__body">
        <StatusNote
          message={state.error ? { tone: "err", text: state.error } : null}
        />
        <output>{state.message}</output>
        {pending ? (
          <ConfirmRevocation
            row={pending}
            busy={state.busy}
            close={close}
            revoke={state.revoke}
          />
        ) : null}
        {rows ? (
          <AuthorityRows
            rows={rows}
            grantsOnly={grantsOnly}
            disabled={state.busy || pending !== null}
            select={(row, button) => {
              trigger.current = button;
              setPending(row);
            }}
          />
        ) : !state.error ? (
          <output>Loading local access records…</output>
        ) : null}
      </div>
    </section>
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
      <p className="hint">
        Record {row.id}. This cannot be undone; new access requires another
        sign-in or approval.
      </p>
      <div className="actions">
        <button
          type="button"
          className="icon-btn icon-btn--danger"
          aria-label="Confirm revocation"
          title="Confirm revocation"
          onClick={() =>
            void revoke(row).then((done) => {
              if (done) close();
            })
          }
        >
          <IconTrash size={16} />
        </button>
        <button
          ref={cancel}
          type="button"
          className="icon-btn"
          onClick={close}
          aria-label="Cancel revocation"
          title="Cancel revocation"
        >
          <IconX size={16} />
        </button>
      </div>
    </fieldset>
  );
}

function AuthorityRows({
  rows,
  grantsOnly,
  disabled,
  select,
}: {
  rows: readonly LocalAuthorityRow[];
  grantsOnly: boolean;
  disabled: boolean;
  select: (row: LocalAuthorityRow, button: HTMLButtonElement) => void;
}) {
  if (!rows.length)
    return (
      <p className="hint">
        {grantsOnly
          ? "No unexpired local application grants."
          : "No unexpired local sessions."}
      </p>
    );
  return (
    <ul className="access-local-records">
      {rows.map((row) => (
        <li key={`${row.kind}:${row.id}`}>
          <strong>{row.name}</strong>
          <p>{row.detail}</p>
          <p className="hint">
            {row.kind} · {row.id} · Expires{" "}
            {new Date(row.expiresAt).toLocaleString()}
          </p>
          <button
            type="button"
            className="icon-btn icon-btn--danger icon-btn--sm"
            disabled={disabled}
            onClick={(event) => select(row, event.currentTarget)}
            aria-label={`Revoke ${row.kind}`}
            title="Revoke"
          >
            <IconTrash size={16} />
          </button>
        </li>
      ))}
    </ul>
  );
}

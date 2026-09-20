import { useEffect, useRef, useState } from "react";
import "./local-authority.css";
import { IconRefresh, IconTrash, IconX } from "../../components/Icons.js";
import { keyboardIsIdle } from "../../lib/focus.js";
import {
  type LocalAuthorityRow,
  useLocalAuthority,
} from "./useLocalAuthority.js";

export function LocalAuthorityPanel({
  tomb,
  grantsOnly = false,
}: { tomb: string; grantsOnly?: boolean }) {
  const state = useLocalAuthority(tomb);
  const rows = grantsOnly
    ? state.rows?.filter((row) => row.kind === "grant")
    : state.rows;
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
        <h2>
          {grantsOnly ? "Local application grants" : "Local sessions & grants"}
        </h2>
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
        {state.error ? (
          <p className="note note--err" role="alert">
            {state.error}
          </p>
        ) : null}
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
          <>
            <p className="hint">
              {!grantsOnly
                ? `Recorded sessions: ${rows.filter((row) => row.kind === "session").length || "-"} · `
                : null}
              Application grants:{" "}
              {rows.filter((row) => row.kind === "grant").length || "-"}
            </p>
            <AuthorityRows
              rows={rows}
              grantsOnly={grantsOnly}
              disabled={state.busy || pending !== null}
              select={(row, button) => {
                trigger.current = button;
                setPending(row);
              }}
            />
          </>
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
          className="btn btn--primary"
          onClick={() =>
            void revoke(row).then((done) => {
              if (done) close();
            })
          }
        >
          Confirm revocation
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
      <p>
        {grantsOnly
          ? "No unexpired local application grants."
          : "No unexpired local sessions or application grants."}
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

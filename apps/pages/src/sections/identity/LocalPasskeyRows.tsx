/**
 * One row per enrolled passkey. The revoke action is an armed icon key
 * (DESIGN.md § Actions are symbols): the first press arms it, the second
 * runs the revocation, and the sibling control keeps the passkey.
 */

import { IconTrash } from "../../components/Icons.js";
import type { useCredentialCommands } from "./LocalPasskeys.js";

export function CredentialRows({
  model,
  disabled,
}: {
  model: ReturnType<typeof useCredentialCommands>;
  disabled: boolean;
}) {
  const { keys, busy, removing, setRemoving, run } = model;
  return (
    <ul className="identity-passkeys">
      {keys?.map((key) => (
        <li key={key.credentialId}>
          <div className="identity-row__main">
            <span>Passkey · {key.credentialId.slice(-8)}</span>
            <span className="hint">
              Enrolled {new Date(key.createdAt).toLocaleDateString()}
              {key.prfCapable
                ? " · This passkey supports encrypted vault unlock."
                : ""}
            </span>
            <div className="actions">
              <button
                type="button"
                className={
                  removing === key.credentialId
                    ? "icon-btn icon-btn--sm icon-btn--danger is-armed"
                    : "icon-btn icon-btn--sm icon-btn--danger"
                }
                disabled={disabled || busy}
                aria-label={
                  removing === key.credentialId
                    ? "Confirm revocation"
                    : "Revoke passkey"
                }
                title={
                  removing === key.credentialId
                    ? "Confirm revocation"
                    : "Revoke passkey"
                }
                onClick={() =>
                  removing === key.credentialId
                    ? void run("revoke", key.credentialId)
                    : setRemoving(key.credentialId)
                }
              >
                <IconTrash size={16} />
              </button>
              {removing === key.credentialId ? (
                <button
                  type="button"
                  className="btn btn--sm"
                  disabled={busy}
                  onClick={(event) => {
                    const primary = event.currentTarget.previousElementSibling;
                    if (primary instanceof HTMLButtonElement) primary.focus();
                    setRemoving(null);
                  }}
                >
                  Keep passkey
                </button>
              ) : null}
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}
